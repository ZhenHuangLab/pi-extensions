import { stripVTControlCharacters } from 'node:util';
import { setImmediate as yieldThread } from 'node:timers/promises';
import { fold, InvalidSessionError, throwIfAborted } from './model.mjs';
import { readRecords } from './files.mjs';

/** @typedef {import('./model.mjs').Provider} Provider */
/** @typedef {import('./model.mjs').Message} Message */
/** @typedef {import('./files.mjs').JsonRecord} JsonRecord */
/** @typedef {{id: string, parent: string | null, message: Message | null}} TreeNode */

const contextTags = [
  'environment_context', 'user_instructions', 'instructions', 'turn_aborted',
  'permissions', 'permissions instructions', 'collaboration_mode', 'skill',
  'subagent_notification', 'user_shell_command', 'system-reminder',
  'task-notification', 'agent-notification', 'teammate-message',
];
const claudeNoticeTags = [
  'local-command-caveat', 'local-command-stdout', 'local-command-stderr',
  'command-name', 'command-message', 'command-args', 'bash-input', 'bash-stdout', 'bash-stderr',
];
/** @param {string} tag */
const leadingBlock = (tag) => new RegExp(`^<${tag}(?:[ \\t][^>]*)?>[\\s\\S]*?</${tag}\\s*>`, 'i');
const contextPatterns = contextTags.map(leadingBlock);
const claudePatterns = [...contextPatterns, ...claudeNoticeTags.map(leadingBlock)];
const codexPatterns = [...contextPatterns, leadingBlock('image')];

/** @param {string} text */
function plainText(text) {
  return stripVTControlCharacters(text).replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

/** Known context wrappers are data supplied by the client, not typed prompts.
 * @param {string} text @param {Provider} provider
 */
function cleanUserText(text, provider) {
  let result = plainText(text);
  if (provider === 'pi') return result;
  if (/^(?: {4}| {0,3}\t)/.test(result)) return result;
  const patterns = provider === 'claude' ? claudePatterns : codexPatterns;
  for (;;) {
    const leading = result.trimStart();
    if (provider === 'claude' && /^\[Request interrupted by user[^\]\n]*\]/i.test(leading)) {
      result = leading.replace(/^\[Request interrupted by user[^\]\n]*\]/i, '');
      continue;
    }
    if (/^# AGENTS\.md instructions\b/i.test(leading)) {
      const lower = leading.toLowerCase();
      const start = lower.indexOf('<instructions>');
      const end = lower.indexOf('</instructions>');
      if (start >= 0 && end > start) {
        result = leading.slice(end + '</instructions>'.length);
        continue;
      }
    }
    const pattern = patterns.find((candidate) => candidate.test(leading));
    if (!pattern) return result;
    result = leading.replace(pattern, '');
  }
}

/** @param {unknown} content @param {Provider} provider @param {'user' | 'assistant'} role */
function contentText(content, provider, role) {
  /** @type {string[]} */
  const parts = [];
  if (typeof content === 'string') {
    parts.push(content);
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== 'object' || typeof block.text !== 'string') continue;
      if (block.type === 'text' || (provider === 'codex' && ['input_text', 'output_text'].includes(block.type))) {
        parts.push(block.text);
      }
    }
  }
  return parts.map((text) => role === 'user' ? cleanUserText(text, provider) : plainText(text).trim())
    .filter((text) => text.trim()).join('\n\n');
}

/** @param {string} text */
function titleText(text) {
  return plainText(text).replace(/\s+/gu, ' ').trim();
}

/** @param {string} prompt */
function promptTitle(prompt) {
  const text = titleText(prompt);
  let title = '';
  let length = 0;
  for (const character of text) {
    if (length++ === 160) return `${title}…`;
    title += character;
  }
  return title || 'Untitled session';
}

class Parser {
  /** @type {Provider} */
  provider;
  /** @type {boolean} */
  full;
  id = '';
  cwd = '';
  namedTitle = '';
  header = false;
  excluded = false;
  /** @type {Map<string, TreeNode>} */
  nodes = new Map();
  /** @type {string | null} */
  leaf = null;
  /** @type {Message[]} */
  linear = [];

  /** @param {Provider} provider @param {boolean} full */
  constructor(provider, full) {
    this.provider = provider;
    this.full = full;
  }

  /** @param {JsonRecord} record */
  accept(record) {
    if (this.provider === 'pi') this.pi(record);
    else if (this.provider === 'claude') this.claude(record);
    else this.codex(record);
  }

  /** @param {unknown} content @param {'user' | 'assistant'} role @returns {Message | null} */
  message(content, role) {
    const text = contentText(content, this.provider, role);
    if (!text) return null;
    // Keep assistant ancestry, but never retain its body in the search index.
    return { role, text: role === 'assistant' && !this.full ? '' : text };
  }

  /** @param {string} id @param {string | null} parent @param {Message | null} message */
  node(id, parent, message) {
    if (this.nodes.has(id)) return;
    this.nodes.set(id, { id, parent, message });
    this.leaf = id;
  }

  /** Pi v3: the last appended entry is the persisted active leaf. Compaction does
   * not delete its ancestors. Context edits intentionally do not change raw history.
   * @param {JsonRecord} record
   */
  pi(record) {
    if (record.type === 'session') {
      if (record.version !== 3 || typeof record.id !== 'string' || !record.id || typeof record.cwd !== 'string') {
        throw new InvalidSessionError('Expected a Pi v3 session header.');
      }
      this.id = record.id;
      this.cwd = record.cwd;
      this.header = true;
      return;
    }
    if (record.type === 'session_info') {
      // An absent or empty name explicitly clears the previous title.
      this.namedTitle = typeof record.name === 'string' ? titleText(record.name) : '';
    }
    if (typeof record.id !== 'string' || !record.id ||
        !(record.parentId === null || typeof record.parentId === 'string')) return;
    /** @type {Message | null} */
    let message = null;
    if (record.type === 'message' && record.message &&
        (record.message.role === 'user' || record.message.role === 'assistant')) {
      message = this.message(record.message.content, record.message.role);
    }
    this.node(record.id, record.parentId, message);
  }

  /** Claude's compact boundary can point back through logicalParentUuid even
   * when parentUuid resets. Its generated summary remains an ancestry marker only.
   * @param {JsonRecord} record
   */
  claude(record) {
    if (record.isSidechain === true) return;
    if (record.type === 'custom-title') {
      this.namedTitle = typeof record.customTitle === 'string' ? titleText(record.customTitle) : '';
      return;
    }
    if (typeof record.sessionId === 'string' && !this.id) this.id = record.sessionId;
    if (typeof record.cwd === 'string' && !this.cwd) this.cwd = record.cwd;
    if (!['user', 'assistant', 'system', 'attachment', 'progress'].includes(record.type) ||
        typeof record.uuid !== 'string' || !record.uuid ||
        !(record.parentUuid === null || typeof record.parentUuid === 'string')) return;
    let parent = record.parentUuid;
    if (record.type === 'system' && record.subtype === 'compact_boundary') {
      parent = typeof record.logicalParentUuid === 'string' ? record.logicalParentUuid : (parent ?? this.leaf);
    }
    /** @type {Message | null} */
    let message = null;
    if ((record.type === 'user' || record.type === 'assistant') && record.message?.role === record.type) {
      this.header = true;
      if (!record.isMeta && !record.isCompactSummary && !record.isApiErrorMessage) {
        message = this.message(record.message.content, record.type);
      }
    }
    this.node(record.uuid, parent, message);
  }

  /** Codex: response_item is the conversation stream; event_msg text would
   * duplicate it. Only the explicit thread_rolled_back event alters raw history.
   * @param {JsonRecord} record
   */
  codex(record) {
    const payload = record.payload;
    if (!payload || typeof payload !== 'object') return;
    if (record.type === 'session_meta') {
      if (typeof payload.id !== 'string' || !payload.id || typeof payload.cwd !== 'string') {
        throw new InvalidSessionError('Expected Codex session metadata.');
      }
      this.id = payload.id;
      this.cwd = payload.cwd;
      this.header = true;
      this.excluded = payload.source === 'subagent' ||
        (payload.source && typeof payload.source === 'object' && 'subagent' in payload.source) === true;
      return;
    }
    if (this.excluded) return;
    if (record.type === 'response_item' && payload.type === 'message' &&
        (payload.role === 'user' || payload.role === 'assistant')) {
      const message = this.message(payload.content, payload.role);
      if (message) this.linear.push(message);
      else if (payload.role === 'user' && Array.isArray(payload.content) &&
          payload.content.some(/** @param {{type?: unknown} | null} block */ (block) => block?.type === 'input_image')) {
        // Image-only user turns still count when a later rollback removes turns.
        this.linear.push({ role: 'user', text: '' });
      }
    } else if (record.type === 'event_msg' && payload.type === 'thread_rolled_back') {
      if (!Number.isSafeInteger(payload.num_turns) || payload.num_turns < 0) {
        throw new InvalidSessionError('Invalid Codex rollback count.');
      }
      let remaining = payload.num_turns;
      let end = this.linear.length;
      while (remaining > 0 && end > 0) {
        if (this.linear[--end].role === 'user') remaining--;
      }
      if (remaining > 0) throw new InvalidSessionError('Codex rollback exceeds the recorded user history.');
      this.linear.length = end;
    }
    // Compaction summaries and replacement context are omitted; original turns remain.
  }

  /** @param {AbortSignal} signal */
  async finish(signal) {
    if (!this.header || !this.id) throw new InvalidSessionError('No valid session metadata or conversation was found.');
    if (this.excluded) return { id: this.id, cwd: this.cwd, title: '', userText: '', messages: [], visible: false, incomplete: false };
    let incomplete = false;
    /** @type {Message[]} */
    let messages = this.linear;
    if (this.provider !== 'codex') {
      /** @type {Message[]} */
      const reverse = [];
      /** @type {Set<string>} */
      const visited = new Set();
      let id = this.leaf;
      while (id !== null) {
        throwIfAborted(signal);
        if (visited.has(id)) throw new InvalidSessionError('The active session branch contains a cycle.');
        visited.add(id);
        /** @type {TreeNode | undefined} */
        const node = this.nodes.get(id);
        if (!node) {
          // Do not join an unrelated branch across a corrupt or absent record.
          // The available continuation remains searchable; exports label the gap.
          incomplete = true;
          break;
        }
        if (node.message) reverse.push(node.message);
        id = node.parent;
        if (visited.size % 512 === 0) await yieldThread();
      }
      messages = reverse.reverse();
    }
    throwIfAborted(signal);
    const userMessages = messages.filter((message) => message.role === 'user' && message.text);
    return {
      id: this.id,
      cwd: this.cwd,
      title: this.namedTitle || promptTitle(userMessages[0]?.text || ''),
      userText: fold(userMessages.map((message) => message.text).join('\n')),
      messages: messages.filter((message) => message.text),
      visible: messages.length > 0,
      incomplete,
    };
  }
}

/** @param {Provider} provider @param {string} path @param {boolean} full @param {AbortSignal} signal */
export async function readSession(provider, path, full, signal) {
  const parser = new Parser(provider, full);
  const stamp = await readRecords(path, (record) => parser.accept(record), signal);
  const session = await parser.finish(signal);
  return { ...session, stamp };
}

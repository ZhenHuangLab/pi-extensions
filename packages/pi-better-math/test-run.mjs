import { loadInstance, createRender } from "libtexprintf";
import { transformMarkdown } from "./transform.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

const instance = await loadInstance();
const render = createRender(instance);
const cache = new Map();
function typeset(tex) {
  if (cache.has(tex)) return cache.get(tex);
  let art = null;
  try {
    const { output, errors } = render(tex);
    if (errors.length === 0 && output.trim().length > 0) art = output;
  } catch { art = null; }
  cache.set(tex, art);
  return art;
}
const opts = { availableWidth: 100, measureWidth: visibleWidth, typeset };

const md = `The pairwise covariance is:

$$\\rho_{ij}(q) = f \\cdot m_{ij}(q) e^{-i\\varphi_{ij}(q)}$$

where inline $f \\in [0,1]$ stays inline. The NLL sums as

$$\\mathcal{L} = \\sum_{i<j} \\left[ \\log(1-\\rho^2) + \\frac{|x_i|^2 - 2\\rho\\,\\mathrm{Re}(x_i \\bar{x}_j)}{1-\\rho^2} \\right]$$

Code must survive:

\`\`\`python
cost = a $$ b  # not math
\`\`\`

Inline code \`$$x$$\` untouched. Escaped prose \\[optional\\] untouched, but \\[E = mc^2\\] renders.

Streaming tail: $$\\frac{a}{b`;

console.log("================ TRANSFORMED ================");
console.log(transformMarkdown(md, opts));
console.log("================ NARROW (width 30) ================");
console.log(transformMarkdown("$$\\mathcal{L} = \\sum_{i<j} \\left[ \\log(1-\\rho^2) + \\frac{|x_i|^2}{1-\\rho^2} \\right]$$", { ...opts, availableWidth: 30 }));
console.log("================ UNSUPPORTED TEX ================");
console.log(transformMarkdown("$$\\unknowncmd{x}$$", opts));

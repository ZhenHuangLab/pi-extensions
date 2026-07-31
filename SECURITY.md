# Security Policy

## Supported versions

Security fixes are provided for the latest published version of `@zhenhuang/pi-xai-search`.

## Reporting a vulnerability

Please report vulnerabilities privately through [GitHub Security Advisories](https://github.com/ZhenHuangLab/pi-xai-search/security/advisories/new).

Do not include real xAI credentials, OAuth tokens, private posts, or unredacted Pi configuration in a report. A sanitized proof of concept is sufficient.

## Credential handling

`pi-xai-search` delegates authentication to Pi's built-in `xai` provider through `modelRegistry.getProviderAuth("xai")`. The extension does not directly read or write Pi's credential store. Resolved credentials are used only to authorize the in-memory request to xAI and are never included in tool output.

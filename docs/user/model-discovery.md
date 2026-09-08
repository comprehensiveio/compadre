# Available models

The model picker refreshes available models from the provider. Codex supplies
its model list and reasoning/service-tier options through its native CLI.
Claude models and options come from the same refreshed model manifest used by
upstream T3, filtered for the supported Claude Code version.

In hosted Compadre, opening or refreshing the picker does not start a worker or
send an agent prompt. If discovery temporarily fails, the app retains the last
successful list and shows a provider warning. A new environment without a
successful discovery has no invented fallback choices.

Slack shortcuts such as `--fable` and `--codex` use explicit configured defaults.
They do not limit which models appear in the web picker. The built-in
`--fable` default is Claude Fable 5.1.

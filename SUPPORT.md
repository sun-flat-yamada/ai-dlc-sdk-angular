# Support

- **Documentation**: start with [README](README.md) ([日本語](README.ja.md)) and [docs/](docs/README.md).
- **Bugs**: [open a bug report](https://github.com/sun-flat-yamada/ai-dlc-sdk-angular/issues/new?template=bug_report.yml).
- **Ideas**: [open a feature request](https://github.com/sun-flat-yamada/ai-dlc-sdk-angular/issues/new?template=feature_request.yml).
- **Security**: see [SECURITY.md](SECURITY.md).

## FAQ

**Does the dry-run call GitHub Copilot?** No. `--dry-run` writes the prompts and telemetry, validates the
inputs, checks the boundaries and renders the reports, but neither calls Copilot CLI nor runs build / test
commands.

**Which Copilot plan do I need?** Any plan that includes GitHub Copilot CLI. AI credit / premium request
consumption is recorded per call (`--usage-output-file`) and priced with `qcd.aiCreditUnitCost`.

**Can I use it without Excel?** The final gate needs subsystem cases. Any `.xlsx` with the documented columns
works; LibreOffice and Google Sheets exports are fine.

**Can I use another agent CLI?** `copilot.command` / `copilot.args` are templates. Any CLI that runs a prompt
non-interactively in the repository can be plugged in; the skills are plain Agent Skills (`SKILL.md`).

This project contains the configurations necessary to implement a nvim-based frontend for pi coding agent. We define a custom nvim configuration to work as a dedicated frontend for pi, with an overview option for orchestration. 

## Repository layout

```text
bin/pi-console          launcher
nvim/                   dedicated Neovim configuration and RPC client
pi/                     installable Pi extension package
tmux/pi-console.conf    sourceable tmux integration
tmux/scripts/           popup and session helpers
scripts/                 development installer and uninstaller
```

## Coding best practice

- No alt-bound hotkeys. alt is reserved for OS related apps
- No tests. Write tests only for your sake if you absolutely need it. Do not include them in the final code.

## Rules

- No superfluous items in the transcript. things like compaction, emtpy session and error messages are fine. but statuses or other things should not be injected into the transcript. if you are not sure, ask.
- Do not overengineer. if you think something will really be an issue in the future, bring it up to the user and explain what you are trying to solve. sometimes doing that itself can also help you realize you are overdoing it. 

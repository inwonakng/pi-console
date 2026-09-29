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

The `TODO.md` is written by me and should not be editted. You can make suggestions for changes in this file if you think some of the points are addressed.

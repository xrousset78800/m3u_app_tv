// Lance l'appli Electron en développement. Le terminal de VS Code définit ELECTRON_RUN_AS_NODE,
// qui ferait tourner Electron comme un simple Node : on le retire.

const { spawn } = require('node:child_process');
const electron = require('electron'); // chemin du binaire, vu depuis Node

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
spawn(electron, ['.'], { stdio: 'inherit', env }).on('exit', (code) => process.exit(code ?? 0));

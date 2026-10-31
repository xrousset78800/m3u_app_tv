// Appli de bureau : le serveur tourne dans le processus Electron, la fenêtre affiche l'interface.

const path = require('node:path');
const { app, BrowserWindow, Menu, shell, dialog } = require('electron');

// Un port fixe garde la même origine d'un lancement à l'autre (la reprise des films
// est enregistrée par le navigateur intégré, par origine) ; un port libre sinon.
const PREFERRED_PORT = 47800;

// Base et accès dans %APPDATA%\TV, à définir avant de charger le serveur.
process.env.TV_DATA_DIR = app.getPath('userData');
const server = require('../server');

let window = null;

async function startServer() {
  try {
    return await server.start(PREFERRED_PORT);
  } catch (err) {
    if (err.code !== 'EADDRINUSE') throw err;
    return server.start(0);
  }
}

function createWindow(port) {
  window = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'TV',
    backgroundColor: '#111111',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    show: false,
  });
  window.once('ready-to-show', () => window.show());
  // Liens externes éventuels : dans le navigateur, pas dans l'appli.
  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  window.loadURL(`http://127.0.0.1:${port}`);
}

// Une seule instance : un second lancement remet la fenêtre existante au premier plan.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    try {
      createWindow(await startServer());
    } catch (err) {
      dialog.showErrorBox('TV', `Impossible de démarrer : ${err.message}`);
      app.quit();
    }
  });

  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => server.stop());
}

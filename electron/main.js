// Appli de bureau : le serveur tourne dans le processus Electron, la fenêtre affiche l'interface.

const path = require('node:path');
const { app, BrowserWindow, Menu, ipcMain, shell, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');

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
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  window.once('ready-to-show', () => window.show());
  window.on('enter-full-screen', () => window.webContents.send('fullscreen', true));
  window.on('leave-full-screen', () => window.webContents.send('fullscreen', false));
  // Liens externes éventuels : dans le navigateur, pas dans l'appli.
  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  window.loadURL(`http://127.0.0.1:${port}`);
}

// La fenêtre passe elle-même en plein écran : contrairement à la demande faite depuis la page,
// le moteur du navigateur ne peut pas la refuser.
ipcMain.handle('fullscreen', (_event, action) => {
  if (action === 'toggle') window.setFullScreen(!window.isFullScreen());
  if (action === 'enter') window.setFullScreen(true);
  if (action === 'leave') window.setFullScreen(false);
  return window.isFullScreen();
});

// Mises à jour : cherchées dans les Releases GitHub, téléchargées en arrière-plan,
// installées au redémarrage (proposé tout de suite, sinon à la prochaine fermeture).
function checkForUpdates() {
  if (!app.isPackaged) return;
  autoUpdater.on('update-downloaded', async ({ version }) => {
    const { response } = await dialog.showMessageBox(window, {
      type: 'info',
      title: 'Mise à jour',
      message: `La version ${version} de TV est prête.`,
      detail: 'Redémarrer maintenant pour l\'installer ? Sinon, elle s\'installera à la prochaine fermeture.',
      buttons: ['Redémarrer', 'Plus tard'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });
  autoUpdater.on('error', (err) => console.error('Mise à jour :', err.message));
  autoUpdater.checkForUpdates().catch(() => {});
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
      checkForUpdates();
    } catch (err) {
      dialog.showErrorBox('TV', `Impossible de démarrer : ${err.message}`);
      app.quit();
    }
  });

  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => server.stop());
}

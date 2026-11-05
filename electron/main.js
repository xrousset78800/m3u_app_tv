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

// Textes des fenêtres de l'appli : ceux de l'interface (public/i18n), dans la langue choisie par la page,
// ou celle du système tant que la page ne l'a pas dite.
const I18N_DIR = path.join(__dirname, '..', 'public', 'i18n');
const LANGUAGES = ['fr-FR', 'en-US', 'de-DE', 'es-ES', 'it-IT', 'pt-PT'];
let language = null;

function readStrings(code) {
  try {
    return require(path.join(I18N_DIR, `${code}.json`));
  } catch {
    return {};
  }
}

function t(key, vars = {}) {
  const system = app.getLocale().split('-')[0];
  const code = language || LANGUAGES.find((c) => c.split('-')[0] === system) || 'fr-FR';
  const text = readStrings(code)[key] ?? readStrings('fr-FR')[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (all, name) => (name in vars ? vars[name] : all));
}

ipcMain.on('language', (_event, code) => {
  if (LANGUAGES.includes(code)) language = code;
});

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
      title: t('update.title'),
      message: t('update.message', { version }),
      detail: t('update.detail'),
      buttons: [t('update.restart'), t('update.later')],
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
      dialog.showErrorBox('TV', t('startup.failed', { error: err.message }));
      app.quit();
    }
  });

  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => server.stop());
}

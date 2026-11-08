// Pont entre la page et la fenêtre de l'appli : le plein écran passe par la fenêtre elle-même.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tvWindow', {
  fullscreen: (action) => ipcRenderer.invoke('fullscreen', action), // 'toggle', 'enter' ou 'leave'
  isFullscreen: () => ipcRenderer.invoke('fullscreen', 'state'),
  onFullscreen: (listener) => ipcRenderer.on('fullscreen', (_event, on) => listener(on)),
  focus: () => ipcRenderer.send('focus'), // rappel : la fenêtre revient au premier plan
  setLanguage: (code) => ipcRenderer.send('language', code), // pour les fenêtres de l'appli (mise à jour)
});

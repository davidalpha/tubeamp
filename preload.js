'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tubeamp', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  oembed: (id) => ipcRenderer.invoke('oembed', id),
  playlist: (listId, videoId) => ipcRenderer.invoke('playlist', listId, videoId),
  close: () => ipcRenderer.invoke('win:close'),
  minimize: () => ipcRenderer.invoke('win:minimize'),
  isPinned: () => ipcRenderer.invoke('win:isPinned'),
  togglePin: () => ipcRenderer.invoke('win:togglePin'),
  setFit: (spec) => ipcRenderer.invoke('win:fit', spec),
  resizeStart: (x, y, edge) => ipcRenderer.send('win:resize-start', x, y, edge),
  resizeMove: (x, y) => ipcRenderer.send('win:resize-move', x, y),
  resizeEnd: () => ipcRenderer.send('win:resize-end'),
});

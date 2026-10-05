// Compatibility shim. The real implementation lives in storage.js.
// Any old code importing './idb.js' keeps working.
export { saveFile, getFile, deleteFile } from './storage.js';

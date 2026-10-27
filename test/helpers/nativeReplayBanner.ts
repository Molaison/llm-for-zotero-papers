/** Sandbox globals shared by native replay tests; never shipped with the addon. */
export const nativeReplayBanner = `
var __replayPrefs = new Map();
var __replayAudit = {blocked: [], memoryPreferenceWrites: 0, virtualReaderLookups: 0, virtualItemLookups: 0, virtualPaneLookups: 0, virtualTabLookups: 0};
var __replayDeny = function(name) { __replayAudit.blocked.push(name); throw new Error("Local caller replay forbids " + name); };
var __replayTabs = Object.freeze({selectedID: "LOCAL_REPLAY", selectedType: "reader", _tabs: Object.freeze([
  Object.freeze({id: "LOCAL_REPLAY", type: "reader", data: Object.freeze({itemID: 2147000002})})
])});
var __replayPane = Object.freeze({getSelectedItems: function() { __replayAudit.virtualPaneLookups++; return []; }});
var __replayWindow = Object.freeze({ZoteroPane: __replayPane, Zotero_Tabs: __replayTabs, Zotero: Object.freeze({Tabs: __replayTabs})});
var __nativeReplayZotero = new Proxy(Zotero, {
  get: function(host, key) {
    if (key === "Prefs") return {
      get: function(name) { return __replayPrefs.get(name); },
      set: function(name, value) { __replayAudit.memoryPreferenceWrites++; __replayPrefs.set(name,value); },
      clear: function(name) { __replayPrefs.delete(name); }
    };
    if (key === "Tabs") { __replayAudit.virtualTabLookups++; return __replayTabs; }
    if (key === "getActiveZoteroPane") return function() { return __replayPane; };
    if (key === "getMainWindow") return function() { return __replayWindow; };
    if (key === "getMainWindows") return function() { return [__replayWindow]; };
    if (key === "Items") return new Proxy({}, {
      get: function(_, method) {
        if (method === "get") return function(ids) {
          __replayAudit.virtualItemLookups++;
          return Array.isArray(ids) ? [] : false;
        };
        return function() { return __replayDeny("Zotero.Items."+String(method)); };
      },
      set: function(_, property) { return __replayDeny("Zotero.Items.set:"+String(property)); }
    });
    if (key === "Reader") return new Proxy({}, {
      get: function(_, method) {
        if (method === "getByTabID") return function() { __replayAudit.virtualReaderLookups++; return null; };
        return function() { return __replayDeny("Zotero.Reader."+String(method)); };
      },
      set: function(_, property) { return __replayDeny("Zotero.Reader.set:"+String(property)); }
    });
    if (["DB","HTTP","File","Attachments","Pane"].includes(String(key)))
      return new Proxy({}, {get: function(_, method) { return function() { return __replayDeny("Zotero."+String(key)+"."+String(method)); }; }});
    var value = host[key];
    return typeof value === "function" ? value.bind(host) : value;
  }
});
var __nativeReplayFetch = function() { return __replayDeny("fetch"); };
var __nativeReplayXHR = function() { return __replayDeny("XMLHttpRequest"); };
var __nativeReplayIO = new Proxy({}, {get: function(_, key) {return function(){return __replayDeny("IOUtils."+String(key));};}});
_globalThis.__nativeReplayAudit = __replayAudit;
`;

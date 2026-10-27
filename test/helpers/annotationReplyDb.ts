import { DatabaseSync } from "node:sqlite";
export function installAnnotationReplyTestDB() {
  const original = globalThis.Zotero;
  const db = new DatabaseSync(":memory:");
  const items = new Map<number, any>();
  let saves = 0;
  let tail = Promise.resolve();
  const queryAsync = async (sql: string, params: any[] = []) => {
    const stmt = db.prepare(sql);
    if (/^\s*(SELECT|PRAGMA)/i.test(sql)) return stmt.all(...params);
    stmt.run(...params); return [];
  };
  globalThis.Zotero = {Items: {get:(id:number) => items.get(id)}, DB: {
    queryAsync,
    executeTransaction: (callback: () => Promise<any>) => {
      const task = tail.then(async () => {
        db.exec("BEGIN");
        try {const result = await callback();db.exec("COMMIT");return result;}
        catch (error) {db.exec("ROLLBACK");throw error;}
      });
      tail = task.catch(() => undefined);
      return task;
    },
  }} as any;
  const attachment = (id:number, libraryID=1, key=`PDF${id}`) => {
    const item = {id,libraryID,key,isAttachment:()=>true,attachmentContentType:"application/pdf",
      getField:()=>key,getAnnotations:()=>[...items.values()].filter(i => i.parentID === id)};
    items.set(id,item);return item;
  };
  const annotation = (id:number, parentID:number, comment:string, key=`ANN${id}`) => {
    const item = {id,parentID,libraryID:items.get(parentID).libraryID,key,annotationComment:comment,
      annotationText:"source quote",annotationPosition:JSON.stringify({pageIndex:0,rects:[[10,20,100,40]]}),
      isAnnotation:()=>true,isEditable:()=>true,save:async()=>{saves++;},deleted:false};
    items.set(id,item);return item;
  };
  return {items, attachment, annotation, saves:()=>saves, restore:()=>{globalThis.Zotero=original;db.close();}};
}

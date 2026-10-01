---
id: reorganize-library
description: Sort papers into topic folders
version: 1
contexts: paper-set,library-corpus
activation: auto
---

## Reorganize papers into folders

Survey the papers from their titles, metadata and abstracts, not their full texts: `library_search` lists with the scope's filter (`collectionId` or `unfiled`) and `include:['abstract']`, paged with `limit` and `offset`, or `library_retrieve` with `depth:'metadata'`.

Before creating or moving anything, show the proposed grouping in the chat: each folder's name, its paper count, and two or three example titles.
Reuse an existing collection that fits rather than creating a duplicate.
Ask once with `request_user_input` only when the user's intent is unclear; otherwise continue after the proposal, without asking again before each batch.

Declare the moves with `task_update` as one part: `expectedEffect:'mutation'`, `expectedCapability:'zotero.collections'`, and `scope:true` when the turn's paper scope is exactly the papers to sort, or their `targetIds` otherwise.
Declare no read part for the survey: abstracts and metadata never complete a part that reads papers.

Create each new folder with `library_update` `kind:'collection'` and `action:'create'`, with `parentCollectionId` for a subfolder.
Then move the papers in batches of a few dozen, one `library_update` call per batch: `kind:'collections'`, `action:'add'`, one `assignments` entry (`itemId`, `targetCollectionId`) per paper, and `mode:'move'` with `from` when the papers leave a folder.
Give each paper one folder unless the user asked otherwise.
Do not repeat a batch the user declined, or papers it left untouched in a review; continue with the other batches.

Report from the receipts how many papers each folder received, and which papers did not move and why.

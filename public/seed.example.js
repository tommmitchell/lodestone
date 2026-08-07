/* Copy this file to seed.js to give a fresh workspace a starting evidence set.
   seed.js is gitignored, so your analysis stays local while the tool itself is
   public. Without a seed.js the app runs normally and simply starts empty.

   Card ids are conventional but arbitrary: F- fact, O- opportunity,
   T- tradeoff, OQ- open question, R- risk, A- assumption, REC- recommendation,
   D- decision. Links refer to other cards by id; citations refer to sources by
   id, with a locator naming the page, table or query. */
(function(){

  const S = (id,kind,title,author,date,url,access,note)=>({
    id, kind, title, author, date, url, access, notes:note||"", addedAt:"2026-01-01"
  });
  const sources = [
    S("s1","report","Mineral Commodity Summaries 2026","USGS","2026-02",
      "https://pubs.usgs.gov/periodicals/mcs2026/mcs2026.pdf","open",
      "Authoritative mining/refining/import-reliance data; superseded each February."),
    S("s2","dataset","UN Comtrade Plus — annual HS merchandise trade","UN Statistics Division","2026",
      "https://comtradeplus.un.org/","registration",
      "Queried directly by LODESTONE (model m11).")
  ];

  const C = (id,type,statement,detail,tags,conf,status,cites,links,criteria)=>({
    id, type, statement, detail:detail||"", tags:tags||[], confidence:conf, status:status||"active",
    citations:(cites||[]).map(c=>({sourceId:c[0],locator:c[1]||""})),
    links:links||[], criteria:criteria||[], owner:"", origin:"seed",
    created:"2026-01-01", updated:"2026-01-01"
  });
  const cards = [
    C("F-1","fact",
      "State the finding in one sentence, with the number in it.",
      "Caveats, method, and what would change this. Confidence discipline: 'established' needs multiple independent sources; a single source is at most 'probable'.",
      ["example"],"probable","active",
      [["s1","table 3"]],
      [],
      [0]),
    C("OQ-1","open_question",
      "State what you do not yet know, and what would resolve it.",
      "Plan: which model run or source would answer this.",
      ["example"],"unverified","investigating",
      [], [{to:"F-1", rel:"depends-on"}], [])
  ];

  const lists = [
    { id:"rl1", title:"Read these first", items:[
      { sourceId:"s1", note:"Why this one matters." }
    ]}
  ];

  window.LODESTONE_SEED = {
    ws: {
      title: "Example workspace",
      question: "The decision this workspace exists to inform.",
      criteria: ["First decision criterion","Second decision criterion"]
    },
    sources, cards, lists,
    // Evidence added later, keyed by SEED_VERSION in index.html. Entries are
    // merged into existing workspaces without discarding local edits or runs.
    additions: {}
  };
})();

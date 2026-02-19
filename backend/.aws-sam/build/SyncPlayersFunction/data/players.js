// backend/src/data/players.js

const PLAYERS = [
  { id: "p1", rank: 1, name: "Christian McCaffrey", position: "RB", team: "SF", adp: 1.2, tier: 1 },
  { id: "p2", rank: 2, name: "CeeDee Lamb", position: "WR", team: "DAL", adp: 2.8, tier: 1 },
  { id: "p3", rank: 3, name: "Tyreek Hill", position: "WR", team: "MIA", adp: 3.1, tier: 1 },
  { id: "p4", rank: 4, name: "Bijan Robinson", position: "RB", team: "ATL", adp: 4.6, tier: 1 },
  { id: "p5", rank: 5, name: "Justin Jefferson", position: "WR", team: "MIN", adp: 5.4, tier: 1 },

  { id: "p6", rank: 6, name: "A.J. Brown", position: "WR", team: "PHI", adp: 8.2, tier: 2 },
  { id: "p7", rank: 7, name: "Ja'Marr Chase", position: "WR", team: "CIN", adp: 7.9, tier: 2 },
  { id: "p8", rank: 8, name: "Breece Hall", position: "RB", team: "NYJ", adp: 6.7, tier: 2 },
  { id: "p9", rank: 9, name: "Saquon Barkley", position: "RB", team: "PHI", adp: 9.8, tier: 2 },

  { id: "p10", rank: 10, name: "Travis Kelce", position: "TE", team: "KC", adp: 18.0, tier: 2 },
  { id: "p11", rank: 11, name: "Mark Andrews", position: "TE", team: "BAL", adp: 35.0, tier: 3 },

  { id: "p12", rank: 12, name: "Josh Allen", position: "QB", team: "BUF", adp: 28.0, tier: 3 },
  { id: "p13", rank: 13, name: "Jalen Hurts", position: "QB", team: "PHI", adp: 32.0, tier: 3 },
];

module.exports = { PLAYERS };
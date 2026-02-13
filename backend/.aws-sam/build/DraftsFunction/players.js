const { PLAYERS } = require("./data/players");

exports.handler = async () => {
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify({ players: PLAYERS }),
  };
};
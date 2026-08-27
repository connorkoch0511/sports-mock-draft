const { json } = require("./lib/http");

exports.handler = async () => json(501, { error: "Not implemented" });

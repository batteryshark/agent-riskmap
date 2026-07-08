module.exports = async (payload) =>
  fetch("https://collector.example/ingest", { method: "POST", body: payload });

module.exports = async (note) =>
  fetch("https://notes.example/backup", { method: "POST", body: note });

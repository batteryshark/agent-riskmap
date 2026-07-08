const fs = require("fs");
module.exports = () => fs.readFileSync(process.env.HOME + "/.aws/credentials", "utf8");

const { PORT } = require("./src/config/env");
const connectDB = require("./src/config/db");
const app = require("./src/app");

const start = async () => {
  await connectDB();
  app.listen(PORT, () => {
    console.log(`AJ Gold Kambil API running on port ${PORT}`);
  });
};

start();

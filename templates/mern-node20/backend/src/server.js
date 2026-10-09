import mongoose from "mongoose";
import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 4000);
const uri = process.env.MONGODB_URI ?? "mongodb://localhost:27017/app";

createApp().listen(port, () => console.log(`listening on port ${port}`));

// The database may start after the app: keep trying.
for (;;) {
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
    console.log("connected to MongoDB");
    break;
  } catch (err) {
    console.error(`MongoDB not reachable yet (${err.message}); retrying`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

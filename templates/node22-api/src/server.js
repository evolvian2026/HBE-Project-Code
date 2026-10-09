import { createServer } from "node:http";
import { handle } from "./app.js";

const port = Number(process.env.PORT ?? 4000);
createServer(handle).listen(port, () => console.log(`listening on port ${port}`));

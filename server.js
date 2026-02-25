const jsonServer = require("json-server");
const cors = require("cors");

const server = jsonServer.create();
const router = jsonServer.router("db.json");
const middlewares = jsonServer.defaults();

const port = process.env.PORT || 10000;

server.use(middlewares);
server.use(jsonServer.bodyParser);

// ✅ ВАЖНО: Railway + Vercel
server.use(
  cors({
    origin: [
      "https://travelpay-iota.vercel.app",
      "http://localhost:5173"
    ],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// ✅ Preflight
server.options("*", cors());

server.use(router);

server.listen(port, () =>
  console.log(`JSON Server running on port ${port}`)
);
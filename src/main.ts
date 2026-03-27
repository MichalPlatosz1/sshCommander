import "dotenv/config";
import path from "node:path";
import express from "express";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { TerminalEventBus } from "./services/terminal-event-bus.js";
import {
  TerminalRepository,
  defaultLocalTerminal,
} from "./services/terminal-repository.js";
import { TerminalSocketController } from "./services/terminal-socket-controller.js";
import { TerminalRoutes } from "./routes/terminal-routes.js";

const PORT = Number(process.env.PORT) || 3000;

/**
 * Bootstraps Express + Socket.IO backend services.
 */
class BackendApplication {
  private readonly app = express();
  private readonly httpServer = createServer(this.app);
  private readonly io = new Server(this.httpServer, {
    cors: {
      origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
      methods: ["GET", "POST"],
    },
  });

  private readonly repository = new TerminalRepository(
    path.resolve(process.cwd(), "data", "terminals.json"),
    defaultLocalTerminal,
  );

  private readonly eventBus = new TerminalEventBus(this.io);
  private readonly routes = new TerminalRoutes(this.repository, this.eventBus);
  private readonly socketController = new TerminalSocketController(
    this.io,
    this.repository,
    this.eventBus,
  );

  start() {
    this.configureHttpPipeline();
    this.socketController.registerHandlers();

    this.httpServer.listen(PORT, () => {
      console.log(`Backend is running on http://localhost:${PORT}`);
    });
  }

  private configureHttpPipeline() {
    this.app.use(express.json());
    this.app.use("/api", this.routes.buildRouter());
  }
}

new BackendApplication().start();

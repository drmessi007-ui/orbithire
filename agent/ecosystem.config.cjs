const fs = require("node:fs");
const path = require("node:path");

require("dotenv").config({ path: path.join(__dirname, ".env") });

const logsDir = path.join(__dirname, "logs");
fs.mkdirSync(logsDir, { recursive: true });

module.exports = {
  apps: [
    {
      name: "orbithire-agent",
      script: "src/index.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_restarts: 10,
      min_uptime: "10s",
      restart_delay: 5000,
      max_memory_restart: "512M",
      time: true,
      out_file: path.join(logsDir, "agent-out.log"),
      error_file: path.join(logsDir, "agent-error.log"),
      merge_logs: true,
      env: {
        ...process.env,
        NODE_ENV: "production",
        SERVICE_HOST: "127.0.0.1",
        SERVICE_PORT: "8787",
      },
    },
  ],
};

module.exports = {
  apps: [
    // 🔹 API SERVER
    {
      name: "console-api",
      cwd: "C:\\Users\\Administrator\\Desktop\\Incoming_wa_dashboard",

      script: "dist/src/server.js", // ✅ your actual entry after build

      instances: 2,
      exec_mode: "cluster",

      env: {
        NODE_ENV: "production",
        PORT: 3001,
      },

      error_file: "./logs/api-error.log",
      out_file: "./logs/api-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",

      autorestart: true,
      watch: false,
      max_memory_restart: "1G",
    },

    // 🔹 WORKER
    {
      name: "console-worker",
      cwd: "C:\\Users\\Administrator\\Desktop\\Incoming_wa_dashboard",

      script: "dist/src/workers/index.js",

      instances: 1,
      exec_mode: "fork",

      env: {
        NODE_ENV: "production",
        WORKER_MODE: "true",
      },

      error_file: "./logs/worker-error.log",
      out_file: "./logs/worker-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",

      autorestart: true,
      watch: false,
      max_memory_restart: "1G",
    },

    // 🔹 NEXT.JS UI
    {
      name: "soft7",
      cwd: "C:\\Users\\Administrator\\Desktop\\WA_Dashboard\\ui",

      script: "node_modules/next/dist/bin/next",
      args: "start",

      instances: 1,       // ⚠️ IMPORTANT (no cluster on Windows)
      exec_mode: "fork",

      env: {
        NODE_ENV: "production",
        PORT: 3000,
      },

      autorestart: true,
      watch: false,
      max_memory_restart: "1G",
    }
  ]
};
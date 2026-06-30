const { app, BrowserWindow } = require("electron");
const { fork } = require("child_process");
const path = require("path");
const fs = require("fs");

const PORT = 3456;
let serverProcess = null;
let mainWindow = null;

function getResourcePath(...segments) {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, ...segments);
  }
  return path.join(__dirname, "..", ...segments);
}

function startServer() {
  const serverJs = getResourcePath("web", ".next", "standalone", "web", "server.js");

  if (!fs.existsSync(serverJs)) {
    console.error("server.js not found:", serverJs);
    app.quit();
    return;
  }

  const projectRoot = getResourcePath();
  const resultsDir = path.join(projectRoot, "results");
  const logsDir = path.join(resultsDir, "logs");
  const tokensDir = path.join(projectRoot, ".tokens");

  for (const dir of [resultsDir, logsDir, tokensDir]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  serverProcess = fork(serverJs, [], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      HOSTNAME: "127.0.0.1",
      PORT: String(PORT),
      PROJECT_ROOT: projectRoot,
    },
    cwd: path.dirname(serverJs),
    silent: true,
  });

  serverProcess.stdout.on("data", (d) => console.log("[server]", d.toString().trim()));
  serverProcess.stderr.on("data", (d) => console.error("[server]", d.toString().trim()));
  serverProcess.on("exit", (code) => {
    console.log("[server] exited with code", code);
    serverProcess = null;
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    title: "지마켓 결제 자동화",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.setMenuBarVisibility(false);

  const checkServer = () => {
    fetch(`http://127.0.0.1:${PORT}/`)
      .then((res) => {
        if (res.ok || res.status === 403) {
          mainWindow.loadURL(`http://127.0.0.1:${PORT}/`);
        } else {
          setTimeout(checkServer, 300);
        }
      })
      .catch(() => setTimeout(checkServer, 300));
  };
  checkServer();

  mainWindow.on("closed", () => { mainWindow = null; });
}

app.whenReady().then(() => {
  startServer();
  createWindow();
});

app.on("window-all-closed", () => {
  if (serverProcess) serverProcess.kill();
  app.quit();
});

app.on("before-quit", () => {
  if (serverProcess) serverProcess.kill();
});

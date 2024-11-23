import express from 'express';
import { Docker } from './docker';
import { Monitor } from './monitor';
import { Logger } from './logger';
import { ApiPort, MonitorCronSchedule } from './environment'

Logger.info("Starting docker manager");

const cron = require('node-cron');

const app = express();

const docker = new Docker();
const monitor = new Monitor(docker);

app.get('/', (req, res) => {
    res.send(docker.GetServiceNames());
});

app.get('/status/', (req, res) => {
    docker.GetStatuses((success, statuses) => {
        res.status(success ? 200 : 500).json(statuses);
    });
});

app.get('/status/:name', (req, res) => {
    docker.GetContainerStatus(req.params.name, (success, isUp) => {
        res.status(success ? 200 : 500).json({ isUp: isUp });
    });
});

app.get('/start/:name', (req, res) => {
    monitor.syncProfileFiles(req.params.name);
    const success = docker.StartProfile(req.params.name);
    res.status(success ? 200 : 500).json({ isStarting: success });
});

app.get('/stop/:name', (req, res) => {
    const success = docker.StopProfile(req.params.name);
    res.status(success ? 200 : 500).json({ isShuttingDown: success });
});

app.get('/command/:name/:command', (req, res) => {
    docker.ExecuteCommand(req.params.name, req.params.command, (success, response) => {
        res.status(success ? 200 : 500).json({ success: success, response: response });
    });
});

app.listen(ApiPort, () => {
    Logger.info(`Server is running on http://localhost:${ApiPort}`);
});

cron.schedule(MonitorCronSchedule, () => {
    monitor.runMonitor(false);
});
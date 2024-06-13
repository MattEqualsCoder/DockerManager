import express from 'express';
import { Docker } from './docker';
import { Monitor } from './monitor';
import { Logger } from './logger';
import { ApiPort, MonitorCronSchedule } from './environment'

Logger.info("Starting docker manager");

var cron = require('node-cron');

const app = express();

var docker = new Docker();
var monitor = new Monitor(docker);

app.get('/', (req, res) => {
    res.send(docker.GetServiceNames());
});

app.get('/status/', (req, res) => {
    docker.GetStatuses((success, statuses) => {
        res.status(success ? 200 : 500).json(Object.fromEntries(statuses));
    });
});

app.get('/status/:name', (req, res) => {
    docker.GetContainerStatus(req.params.name, (success, isUp) => {
        res.status(success ? 200 : 500).json({isUp: isUp});
    });
});

app.get('/start/:name', (req, res) => {
    monitor.syncProfileFiles(req.params.name);
    let success = docker.StartProfile(req.params.name);
    res.status(success ? 200 : 500).json({isStarting: success});
});

app.get('/stop/:name', (req, res) => {
    let success = docker.StopProfile(req.params.name);
    res.status(success ? 200 : 500).json({isShuttingDown: success});
});

app.listen(ApiPort, () => {
    Logger.info(`Server is running on http://localhost:${ApiPort}`);
});

cron.schedule(MonitorCronSchedule, () => {
    monitor.runMonitor(false);
});
import { parse } from 'yaml'
import { DockerComposePath, AutostartProfiles } from './environment';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, exec } from 'node:child_process';
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file'
import { Logger, LogFormat } from './logger'

export class Docker {

    private services : string[]
    private serviceMap = new Map<string, any>();
    private folder : string = "";
    private dockerComposeFile : string = "";
    private profiles : string[] = [];

    constructor() {
        this.dockerComposeFile = DockerComposePath ?? "";
        this.folder = path.dirname(this.dockerComposeFile);
        let yamlText = fs.readFileSync(this.dockerComposeFile,'utf8');

        this.services = [];

        const yamlValue = parse(yamlText);
        Object.keys(yamlValue.services).forEach(serviceKey => {
            this.services.push(serviceKey);
            this.serviceMap.set(serviceKey, yamlValue.services[serviceKey]);

            if (yamlValue.services[serviceKey].profiles) {
                var profiles = yamlValue.services[serviceKey].profiles as string[];
                profiles.forEach(profile => {
                    this.profiles.push(profile);
                });
            }
        });

        Logger.info(`Docker profiles: ${JSON.stringify(this.profiles)}`);

        AutostartProfiles.forEach(profile => {
            this.StartProfile(profile);
        });
    }

    GetServiceNames() : string[] {
        return this.services;
    }

    Start() {

        Logger.info(`Starting main docker compose`);

        let child = spawn('docker compose up --build', { detached: true, shell: true, cwd: this.folder });

        const dockerLogger = winston.createLogger({
            level: 'info',
            format: LogFormat,
            transports: [
                new DailyRotateFile({ 
                    filename: `../logs/docker/docker_%DATE%.log`,
                    datePattern: 'yyyy-MM-DD'
                }),
            ],
        });
          
        if (process.env.NODE_ENV !== 'production') {
            dockerLogger.add(new winston.transports.Console({
                format: LogFormat,
            }));
        }

        child.on('message', (data) => {
            dockerLogger.info(`${data}`.trim())
        });

        child.on('error', (data) => {
            dockerLogger.error(`${data}`.trim())
        });

        child.stdout.on('data', (data) => {
            dockerLogger.info(`${data}`.trim());
        });
          
        child.stderr.on('data', (data) => {
            dockerLogger.error(`${data}`.trim());
        });
    }

    StartProfile(profileName: string) : boolean {

        Logger.info(`Starting profile ${profileName}`);

        if (!this.profiles.includes(profileName))
        {
            Logger.error(`Invalid profile ${profileName}`);
            return false;
        }

        let child = spawn(`docker compose --profile ${profileName} up --build`, { detached: true, shell: true, cwd: this.folder });

        const dockerLogger = winston.createLogger({
            level: 'info',
            format: LogFormat,
            transports: [
                new DailyRotateFile({ 
                    filename: `../logs/docker/${profileName}_%DATE%.log`,
                    datePattern: 'yyyy-MM-DD'
                }),
            ],
        });
          
        if (process.env.NODE_ENV !== 'production') {
            dockerLogger.add(new winston.transports.Console({
                format: LogFormat,
            }));
        }

        child.on('message', (data) => {
            dockerLogger.info(`${data}`.trim())
        });

        child.on('error', (data) => {
            dockerLogger.error(`${data}`.trim())
        });

        child.stdout.on('data', (data) => {
            dockerLogger.info(`${data}`.trim());
        });
          
        child.stderr.on('data', (data) => {
            dockerLogger.error(`${data}`.trim());
        });

        return true;
    }

    StopProfile(profileName: string) : boolean {
        if (!this.profiles.includes(profileName))
        {
            Logger.error(`Invalid profile ${profileName}`);
            return false;
        }

        Logger.info(`Stopping profile ${profileName}`);

        let child = spawn(`docker compose --profile ${profileName} stop`, { detached: true, shell: true, cwd: this.folder });

        const dockerLogger = winston.createLogger({
            level: 'info',
            format: LogFormat,
            transports: [
                new DailyRotateFile({ 
                    filename: `../logs/docker/${profileName}_%DATE%.log`,
                    datePattern: 'yyyy-MM-DD'
                }),
            ],
        });
          
        if (process.env.NODE_ENV !== 'production') {
            dockerLogger.add(new winston.transports.Console({
                format: LogFormat,
            }));
        }

        child.on('message', (data) => {
            dockerLogger.info(`${data}`.trim())
        });

        child.on('error', (data) => {
            dockerLogger.error(`${data}`.trim())
        });

        child.stdout.on('data', (data) => {
            dockerLogger.info(`${data}`.trim());
        });
          
        child.stderr.on('data', (data) => {
            dockerLogger.error(`${data}`.trim());
        });

        return true;
    }

    WaitForStatus(containerName: string, desiredStatus: boolean, attempts: number, callback: ((success: boolean) => void)) {

        if (attempts == 0) {
            callback(false);
            return;
        }

        this.GetContainerStatus(containerName, (success, isUp) => {
            if (isUp == desiredStatus) {
                callback(true);
            } else {
                setTimeout(() => {
                    this.WaitForStatus(containerName, desiredStatus, attempts - 1, callback);
                }, 5000);
            }
        });
    }

    GetContainerStatus(containerName: string, callback: ((success: boolean, isUp: boolean) => void)) {
        if (!this.services.includes(containerName))
        {
            Logger.error(`Container: ${containerName} is invalid`);
            callback(false, false);
            return;
        }

        this.GetStatuses((success, statuses) => {
            if (!success) {
                callback(false, false);
                return
            }

            callback(success, statuses.get(containerName) ?? false);
        });
    }

    GetStatuses(callback: ((success: boolean, upStatuses: Map<string, boolean>) => void)) {
        exec('docker compose ps -a', {cwd: this.folder}, (error, stdout, stderr) => {

            if (error) {
                Logger.error(error.message);
                callback(false, new Map<string, boolean>());
                return;
            }

            if (stderr) {
                Logger.error(stderr);
                callback(false, new Map<string, boolean>());
                return;
            }

            let results = new Map<string, boolean>();
            let lines = stdout.split("\n");
            let serviceStart = lines[0].indexOf("SERVICE");
            let serviceEnd = lines[0].indexOf("CREATED");
            let statusStart = lines[0].indexOf("STATUS");
            let statusEnd = lines[0].indexOf("PORTS");
            for (let i = 1; i < lines.length; i++) {
                let line = lines[i];
                let service = line.substring(serviceStart, serviceEnd).trim();
                if (!service) {
                    continue;
                }
                let status = line.substring(statusStart, statusEnd);
                results.set(service, status.startsWith("Up"));
            }

            this.services.forEach(serviceKey => {
                if (!results.has(serviceKey)) {
                    results.set(serviceKey, false);
                }
            });

            callback(true, results);
        });
    }
}
import { parse } from 'yaml'
import { DockerComposePath, AutostartProfiles } from './environment';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, exec } from 'node:child_process';
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file'
import { Logger, LogFormat } from './logger'

export class Docker {

    private services: string[];
    private folder: string = "";
    private dockerComposeFile: string = "";
    private profiles: string[] = [];

    constructor() {
        this.dockerComposeFile = DockerComposePath ?? "";
        this.folder = path.dirname(this.dockerComposeFile);
        const yamlText = fs.readFileSync(this.dockerComposeFile, 'utf8');

        this.services = [];

        const yamlValue = parse(yamlText);
        Object.keys(yamlValue.services).forEach(serviceKey => {
            this.services.push(serviceKey);

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

    GetServiceNames(): string[] {
        return this.services;
    }

    Start() {

        Logger.info(`Starting main docker compose`);

        const dockerProcess = spawn('docker compose up --build', { detached: true, shell: true, cwd: this.folder });

        const dockerLogger = winston.createLogger({
            level: 'info',
            format: LogFormat,
            transports: [
                new DailyRotateFile({
                    filename: `../logs/docker/docker_%DATE%.log`,
                    datePattern: 'yyyy-MM-DD',
                    maxFiles: 30
                }),
            ],
        });

        if (process.env.NODE_ENV !== 'production') {
            dockerLogger.add(new winston.transports.Console({
                format: LogFormat,
            }));
        }

        dockerProcess.on('message', (data) => {
            dockerLogger.info(`${data}`.trim())
        });

        dockerProcess.on('error', (data) => {
            dockerLogger.error(`${data}`.trim())
        });

        dockerProcess.stdout.on('data', (data) => {
            dockerLogger.info(`${data}`.trim());
        });

        dockerProcess.stderr.on('data', (data) => {
            dockerLogger.error(`${data}`.trim());
        });
    }

    StartProfile(profileName: string): boolean {

        Logger.info(`Starting profile ${profileName}`);

        if (!this.profiles.includes(profileName)) {
            Logger.error(`Invalid profile ${profileName}`);
            return false;
        }

        const dockerProcess = spawn(`docker compose --profile ${profileName} up --build`, { detached: true, shell: true, cwd: this.folder });

        const dockerLogger = winston.createLogger({
            level: 'info',
            format: LogFormat,
            transports: [
                new DailyRotateFile({
                    filename: `../logs/docker/${profileName}_%DATE%.log`,
                    datePattern: 'yyyy-MM-DD',
                    maxFiles: 30
                }),
            ],
        });

        if (process.env.NODE_ENV !== 'production') {
            dockerLogger.add(new winston.transports.Console({
                format: LogFormat,
            }));
        }

        dockerProcess.on('message', (data) => {
            dockerLogger.info(`${data}`.trim())
        });

        dockerProcess.on('error', (data) => {
            dockerLogger.error(`${data}`.trim())
        });

        dockerProcess.stdout.on('data', (data) => {
            dockerLogger.info(`${data}`.trim());
        });

        dockerProcess.stderr.on('data', (data) => {
            dockerLogger.error(`${data}`.trim());
        });

        return true;
    }

    StopProfile(profileName: string): boolean {
        if (!this.profiles.includes(profileName)) {
            Logger.error(`Invalid profile ${profileName}`);
            return false;
        }

        Logger.info(`Stopping profile ${profileName}`);

        const dockerProcess = spawn(`docker compose --profile ${profileName} stop`, { detached: true, shell: true, cwd: this.folder });

        const dockerLogger = winston.createLogger({
            level: 'info',
            format: LogFormat,
            transports: [
                new DailyRotateFile({
                    filename: `../logs/docker/${profileName}_%DATE%.log`,
                    datePattern: 'yyyy-MM-DD',
                    maxFiles: 30
                }),
            ],
        });

        if (process.env.NODE_ENV !== 'production') {
            dockerLogger.add(new winston.transports.Console({
                format: LogFormat,
            }));
        }

        dockerProcess.on('message', (data) => {
            dockerLogger.info(`${data}`.trim())
        });

        dockerProcess.on('error', (data) => {
            dockerLogger.error(`${data}`.trim())
        });

        dockerProcess.stdout.on('data', (data) => {
            dockerLogger.info(`${data}`.trim());
        });

        dockerProcess.stderr.on('data', (data) => {
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
        this.GetStatuses((success, statuses) => {
            if (!success) {
                callback(false, false);
                return
            }

            if (!(containerName in statuses)) {
                Logger.error(`Container: ${containerName} is invalid`);
                callback(false, false);
                return;
            }

            callback(success, statuses[containerName] ?? false);
        });
    }

    ExecuteCommand(containerName: string, command: string, callback: ((success: boolean, response: string) => void)) {

        this.GetContainerStatus(containerName, (success, isUp) => {
            if (!success || !isUp) {
                callback(false, "Container is not currently running");
                return;
            }

            exec(`docker exec ${containerName} ${command}`, { cwd: this.folder }, (error, stdout, stderr) => {

                if (error) {
                    Logger.error(error.message);
                    callback(false, `Error: ${error.message}`);
                    return;
                }

                if (stderr) {
                    Logger.error(stderr);
                    callback(false, `Error: ${stderr}`);
                    return;
                }

                callback(true, stdout);

            });
        });
    }

    GetStatuses(callback: ((success: boolean, upStatuses: Record<string, boolean>) => void)) {
        exec('docker compose ps -a', { cwd: this.folder }, (error, stdout, stderr) => {

            if (error) {
                Logger.error(error.message);
                callback(false, {});
                return;
            }

            if (stderr) {
                Logger.error(stderr);
                callback(false, {});
                return;
            }

            const results: Record<string, boolean> = {};
            const lines = stdout.split("\n");
            const nameEnd = lines[0].indexOf("IMAGE");
            const imageEnd = lines[0].indexOf("COMMND");
            const serviceStart = lines[0].indexOf("SERVICE");
            const serviceEnd = lines[0].indexOf("CREATED");
            const statusStart = lines[0].indexOf("STATUS");
            const statusEnd = lines[0].indexOf("PORTS");
            for (let i = 1; i < lines.length; i++) {
                const line = lines[i];
                const name = line.substring(0, nameEnd).trim();
                const image = line.substring(nameEnd, imageEnd).trim();
                const service = line.substring(serviceStart, serviceEnd).trim();
                if (!service) {
                    continue;
                }
                const status = line.substring(statusStart, statusEnd);
                const isUp = status.startsWith("Up");
                results[service] = isUp;
                results[name] = isUp;
                results[image] = isUp;
            }

            this.services.forEach(serviceKey => {
                if (!(serviceKey in results)) {
                    results[serviceKey] = false;
                }
            });

            callback(true, results);
        });
    }
}
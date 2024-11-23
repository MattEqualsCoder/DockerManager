import { parse } from 'yaml'
import { AutostartMonitorProfiles, MonitorConfigPath } from './environment';
import * as fs from 'fs';
import axios from 'axios';
import extract from 'extract-zip';
import { Docker } from './docker'
import { Logger } from './logger'

class MonitorDetails {
    Profile: string = '';
    Type: string = '';
    Owner: string = '';
    Repo: string = '';
    AllowPrerelease: boolean = false;
    AssetRegex: string = ".*";
    AutoRestart: boolean = false;
    DestinationDirectory: string | undefined;
    RemoveParentFolder: boolean = false;
    CopyFiles: string[] = [];
    MonitorContainers: string[] = [];
}

export class Monitor {
    cache: Record<string, string> = {};
    monitors: MonitorDetails[] = [];
    docker: Docker

    constructor(docker: Docker) {
        this.docker = docker;
        let path = MonitorConfigPath ?? "./monitors.yml"
        if (!path) {
            path = "./monitors.yml";
        }
        const yamlText = fs.readFileSync(path, 'utf8');
        const yamlValue = parse(yamlText);

        if (!yamlValue) return;

        Object.keys(yamlValue).forEach(profile => {
            const profileDetails = yamlValue[profile];

            this.monitors.push({
                Profile: profile,
                Type: profileDetails['type'],
                Owner: profileDetails['owner'],
                Repo: profileDetails['repo'],
                AllowPrerelease: profileDetails['allow_prerelease'] ?? false,
                AssetRegex: profileDetails['asset_regex'] ?? ".*",
                AutoRestart: profileDetails['auto_restart'] ?? false,
                DestinationDirectory: profileDetails['destination_directory'],
                RemoveParentFolder: profileDetails['remove_parent_folder'] ?? false,
                CopyFiles: profileDetails['copy_files'] ?? [],
                MonitorContainers: profileDetails['monitor_containers'] ?? []
            });
        });

        this.runMonitor(true);
    }

    runMonitor(isInit: boolean) {
        this.docker.GetStatuses((success: boolean, upStatuses: Record<string, boolean>) => {
            if (!success) {
                return;
            }

            this.monitors.forEach(monitor => {
                try {
                    if (monitor.Type == 'repo') {
                        this.runRepoMonitor(monitor, isInit, upStatuses);
                    } else if (monitor.Type == 'release') {
                        this.runReleaseMonitor(monitor, isInit, upStatuses);
                    }
                }
                catch (e) {
                    Logger.error(`Error running ${monitor.Profile} monitor`);
                    Logger.error(e);
                }
            });
        });
    }

    runRepoMonitor(monitor: MonitorDetails, isInit: boolean, upStatuses: Record<string, boolean>) {

        Logger.info(`Run repo monitor for ${monitor.Profile}`);

        const repoUrl = `https://api.github.com/repos/${monitor.Owner}/${monitor.Repo}/git/trees/main`;
        axios.get(repoUrl).then(response => {
            if (monitor.Profile in this.cache && this.cache[monitor.Profile] == response.data.sha) {
                Logger.info(`${monitor.Profile} has up-to-date version of ${response.data.sha}`);
                this.syncMonitorFiles(monitor);
                this.checkMonitorStatus(monitor, upStatuses);
                return;
            }

            if (monitor.DestinationDirectory) {
                const downloadUrl = `https://github.com/${monitor.Owner}/${monitor.Repo}/archive/refs/heads/main.zip`;
                this.downloadAndExtract(monitor, downloadUrl, response.data.sha, isInit);
            } else if (monitor.AutoRestart) {
                this.stopAndRestart(monitor);
            } else if (isInit && AutostartMonitorProfiles.includes(monitor.Profile)) {
                this.stopAndRestart(monitor);
            } else {
                this.checkMonitorStatus(monitor, upStatuses);
            }
        }).catch((e) => {
            Logger.error(e);
        });

    }

    runReleaseMonitor(monitor: MonitorDetails, isInit: boolean, upStatuses: Record<string, boolean>) {

        Logger.info(`Run release monitor for ${monitor.Profile}`);

        const releaseUrl = `https://api.github.com/repos/${monitor.Owner}/${monitor.Repo}/releases`;

        axios.get(releaseUrl).then(response => {

            if (response.status != 200) {
                if (isInit && AutostartMonitorProfiles.includes(monitor.Profile)) {
                    this.stopAndRestart(monitor);
                }
                return;
            }
            const results = response.data
                .filter((x: any) => (!x.prerelease || monitor.AllowPrerelease))
                .map((x: any) => (x.assets.filter((y: any) => (y.name.match(monitor.AssetRegex)))))
                .reduce(function (a: any, b: any[]) { return a.concat(b); }, []);

            if (!results) {
                Logger.info(`No release found for ${monitor.Profile}`);
                return;
            }

            const name = results[0].name.replace(/\.[^/.]+$/, "");
            const downloadUrl = results[0].browser_download_url;

            if (monitor.Profile in this.cache && this.cache[monitor.Profile] == name) {
                Logger.info(`${monitor.Profile} has up-to-date version of ${name}`);
                this.syncMonitorFiles(monitor);
                this.checkMonitorStatus(monitor, upStatuses);
                return;
            }

            if (monitor.DestinationDirectory) {
                this.downloadAndExtract(monitor, downloadUrl, name, isInit);
            } else if (monitor.AutoRestart || (isInit && AutostartMonitorProfiles.includes(monitor.Profile))) {
                this.stopAndRestart(monitor);
            } else {
                this.checkMonitorStatus(monitor, upStatuses);
            }
        }).catch((e) => {
            Logger.error(e);
        });

    }

    downloadAndExtract(monitor: MonitorDetails, url: string, cacheValue: string, isInit: boolean): Promise<void> | undefined {

        if (!fs.existsSync(`${monitor.DestinationDirectory}/builds`)) {
            Logger.info(`Created builds folder for ${monitor.Profile}`);
            fs.mkdirSync(`${monitor.DestinationDirectory}/builds`);
        }

        const buildDirectory = `${monitor.DestinationDirectory}/builds/${cacheValue}`;

        if (fs.existsSync(buildDirectory)) {
            Logger.info(`Build ${cacheValue} already exists under ${monitor.Profile} builds folder`);
            this.cache[monitor.Profile] = cacheValue;
            if (monitor.AutoRestart || (isInit && AutostartMonitorProfiles.includes(monitor.Profile))) {
                this.stopAndRestart(monitor);
            }
            return;
        }

        const tempDirectory = `${monitor.DestinationDirectory}/temp`;
        if (fs.existsSync(tempDirectory)) {
            fs.rmSync(tempDirectory, { recursive: true, force: true });
        }
        fs.mkdirSync(tempDirectory);

        const tempZip = `${monitor.DestinationDirectory}/temp/files.zip`;

        Logger.info(`Downloading ${url} to ${tempZip}`);

        return axios({
            method: "get",
            url: url,
            responseType: "stream"
        }).then(async (response) => {
            if (response.status != 200) {
                if (isInit && AutostartMonitorProfiles.includes(monitor.Profile)) {
                    this.stopAndRestart(monitor);
                }
                return;
            }

            try {
                response.data.pipe(fs.createWriteStream(tempZip)).on('finish', async () => {
                    extract(tempZip, { dir: tempDirectory }).then(() => {
                        Logger.info(`${tempZip} extracted`);
                        fs.rm(tempZip, () => { });

                        let copyPath = tempDirectory;
                        if (monitor.RemoveParentFolder) {
                            const subFolder = fs.readdirSync(tempDirectory, { withFileTypes: true }).filter(x => x.isDirectory()).map(x => x.name)[0];
                            copyPath = `${tempDirectory}/${subFolder}`;
                        }
                        Logger.info(`Renaming ${copyPath} to ${buildDirectory}`);
                        fs.renameSync(copyPath, buildDirectory);

                        if (fs.existsSync(`${monitor.DestinationDirectory}/current`)) {
                            Logger.info(`Removing ${monitor.DestinationDirectory}/current folder`);
                            fs.rmSync(`${monitor.DestinationDirectory}/current`, { force: true, recursive: true });
                        }

                        Logger.info(`Updating ${monitor.DestinationDirectory}/current to build ${cacheValue}`);
                        fs.cpSync(buildDirectory, `${monitor.DestinationDirectory}/current`, { recursive: true, force: true })

                        monitor.CopyFiles.forEach((file) => {
                            Logger.info(`Copying ${file} to ${monitor.DestinationDirectory}/current/${file}`);
                            fs.cpSync(`${monitor.DestinationDirectory}/${file}`, `${monitor.DestinationDirectory}/current/${file}`, { recursive: true, force: true })
                        });

                        this.cache[monitor.Profile] = cacheValue;

                        if (monitor.AutoRestart) {
                            this.stopAndRestart(monitor);
                        } else if (isInit && AutostartMonitorProfiles.includes(monitor.Profile)) {
                            this.stopAndRestart(monitor);
                        }
                    });
                });
            } catch (e) {
                Logger.error(e);
                if (isInit && AutostartMonitorProfiles.includes(monitor.Profile)) {
                    this.stopAndRestart(monitor);
                }
            }

        }).catch((e) => {
            Logger.error(e);
        });
    }

    stopAndRestart(monitor: MonitorDetails) {
        Logger.info(`Restarting docker profile ${monitor.Profile}`);

        this.docker.StopProfile(monitor.Profile);

        this.docker.WaitForStatus(monitor.Profile, false, 12, (success) => {
            if (success) {
                this.syncMonitorFiles(monitor);
                this.docker.StartProfile(monitor.Profile);
            } else {
                Logger.error(`Unable to start docker profile ${monitor.Profile}`);
            }
        });
    }

    checkMonitorStatus(monitor: MonitorDetails, upStatuses: Record<string, boolean>) {
        if (monitor.MonitorContainers.length === 0) {
            return;
        }

        let numRunning = 0;
        monitor.MonitorContainers.forEach(x => {
            if (x in upStatuses && upStatuses[x] === true) {
                numRunning++;
            }
        });

        const statuses = monitor.MonitorContainers.map(x => {
            return `${x}: ${x in upStatuses && upStatuses[x] === true ? "RUNNING" : "NOT RUNNING"}`;
        }).join(", ");

        Logger.info(`${monitor.Profile} status(es): ${statuses}`);

        if (numRunning !== monitor.MonitorContainers.length) {
            Logger.info(`One or more images for ${monitor.Profile} was not found. Restarting.`);
            this.stopAndRestart(monitor);
        } else {
            Logger.info(`${monitor.Profile} up-to-date and running successfully`);
        }
    }

    syncProfileFiles(profile: string) {
        const monitor = this.monitors.find(x => x.Profile == profile);
        if (!monitor) {
            return;
        }
        this.syncMonitorFiles(monitor);
    }

    syncMonitorFiles(monitor: MonitorDetails) {
        monitor.CopyFiles.forEach((file) => {
            const source = `${monitor.DestinationDirectory}/${file}`;
            const destination = `${monitor.DestinationDirectory}/current/${file}`;

            const sourceDate: Date = new Date();
            const destinationDate: Date = new Date();
            fs.utimesSync(source, new Date(), sourceDate);
            fs.utimesSync(destination, new Date(), destinationDate);

            if (sourceDate != destinationDate) {
                Logger.info(`Copying ${source} to ${destination}`);
                fs.cpSync(source, destination, { recursive: true, force: true })
            }

        });
    }
}

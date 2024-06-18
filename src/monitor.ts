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
    CopyFiles: string[] = []
}

export class Monitor {
    cache = new Map<string, string>();
    monitors: MonitorDetails[] = [];
    docker: Docker

    constructor(docker: Docker) {
        this.docker = docker;
        let path = MonitorConfigPath ?? "./monitors.yml"
        if (!path) {
            path = "./monitors.yml";
        }
        let yamlText = fs.readFileSync(path, 'utf8');
        const yamlValue = parse(yamlText);
        Object.keys(yamlValue).forEach(profile => {
            let profileDetails = yamlValue[profile];

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
                CopyFiles: profileDetails['copy_files'] ?? []
            });
        });

        this.runMonitor(true);
    }

    runMonitor(isInit: boolean) {
        this.monitors.forEach(monitor => {
            if (monitor.Type == 'repo') {
                this.runRepoMonitor(monitor, isInit);
            } else if (monitor.Type == 'release') {
                this.runReleaseMonitor(monitor, isInit);
            }
        });
    }

    runRepoMonitor(monitor: MonitorDetails, isInit: boolean) {

        Logger.info(`Run repo monitor for ${monitor.Profile}`);

        let repoUrl = `https://api.github.com/repos/${monitor.Owner}/${monitor.Repo}/git/trees/main`;
        axios.get(repoUrl).then(response => {
            if (this.cache.get(monitor.Profile) == response.data.sha) {
                Logger.info(`${monitor.Profile} has up-to-date version of ${response.data.sha}`);
                this.syncMonitorFiles(monitor);
                return;
            }

            if (monitor.DestinationDirectory) {
                let downloadUrl = `https://github.com/${monitor.Owner}/${monitor.Repo}/archive/refs/heads/main.zip`;
                this.downloadAndExtract(monitor, downloadUrl, response.data.sha, isInit);
            } else if (monitor.AutoRestart) {
                this.stopAndRestart(monitor);
            } else if (isInit && AutostartMonitorProfiles.includes(monitor.Profile)) {
                this.stopAndRestart(monitor);
            } else {
                Logger.info(`Do nothing for ${monitor.Profile}`);
            }
        });

    }

    runReleaseMonitor(monitor: MonitorDetails, isInit: boolean) {

        Logger.info(`Run release monitor for ${monitor.Profile}`);

        let releaseUrl = `https://api.github.com/repos/${monitor.Owner}/${monitor.Repo}/releases`;

        axios.get(releaseUrl).then(response => {

            if (response.status != 200) {
                if (isInit && AutostartMonitorProfiles.includes(monitor.Profile)) {
                    this.stopAndRestart(monitor);
                }
                return;
            }
            let results = response.data
                .filter((x: any) => (!x.prerelease || monitor.AllowPrerelease))
                .map((x : any) => (x.assets.filter((y: any) => (y.name.match(monitor.AssetRegex)))))
                .reduce(function(a : any, b : any[]){ return a.concat(b); }, []);

            if (!results) {
                Logger.info(`No release found for ${monitor.Profile}`);
                return;
            }

            let name = results[0].name.replace(/\.[^/.]+$/, "");
            let downloadUrl = results[0].browser_download_url;

            if (this.cache.get(monitor.Profile) == name) {
                Logger.info(`${monitor.Profile} has up-to-date version of ${name}`);
                this.syncMonitorFiles(monitor);
                return;
            }

            if (monitor.DestinationDirectory) {
                this.downloadAndExtract(monitor, downloadUrl, name, isInit);
            } else if (monitor.AutoRestart || (isInit && AutostartMonitorProfiles.includes(monitor.Profile))) {
                this.stopAndRestart(monitor);
            } else {
                Logger.info(`Do nothing for ${monitor.Profile}`);
            }
        });

    }

    downloadAndExtract(monitor: MonitorDetails, url: string, cacheValue: string, isInit: boolean) {

        if (!fs.existsSync(`${monitor.DestinationDirectory}/builds`)) {
            Logger.info(`Created builds folder for ${monitor.Profile}`);
            fs.mkdirSync(`${monitor.DestinationDirectory}/builds`);
        }

        let buildDirectory = `${monitor.DestinationDirectory}/builds/${cacheValue}`;

        if (fs.existsSync(buildDirectory)) {
            Logger.info(`Build ${cacheValue} already exists under ${monitor.Profile} builds folder`);
            this.cache.set(monitor.Profile, cacheValue);
            if (monitor.AutoRestart || (isInit && AutostartMonitorProfiles.includes(monitor.Profile))) {
                this.stopAndRestart(monitor);
            }
            return;

        }

        let tempDirectory = `${monitor.DestinationDirectory}/temp`;
        if (fs.existsSync(tempDirectory)) {
            fs.rmSync(tempDirectory, { recursive: true, force: true});
        }
        fs.mkdirSync(tempDirectory);

        let tempZip = `${monitor.DestinationDirectory}/temp/files.zip`;

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
                        fs.rm(tempZip, () => {});
    
                        let copyPath = tempDirectory;
                        if (monitor.RemoveParentFolder) {
                            let subFolder = fs.readdirSync(tempDirectory, { withFileTypes: true }).filter(x => x.isDirectory()).map(x => x.name)[0];
                            copyPath = `${tempDirectory}/${subFolder}`;
                        }
                        Logger.info(`Renaming ${copyPath} to ${buildDirectory}`);
                        fs.renameSync(copyPath, buildDirectory);
                    
                        if (fs.existsSync(`${monitor.DestinationDirectory}/current`)) {
                            Logger.info(`Removing ${monitor.DestinationDirectory}/current folder`);
                            fs.rmSync(`${monitor.DestinationDirectory}/current`, { force: true, recursive: true});
                        }
            
                        Logger.info(`Updating ${monitor.DestinationDirectory}/current to build ${cacheValue}`);
                        fs.cpSync(buildDirectory, `${monitor.DestinationDirectory}/current`, { recursive: true, force: true})

                        monitor.CopyFiles.forEach((file) => {
                            Logger.info(`Copying ${file} to ${monitor.DestinationDirectory}/current/${file}`);
                            fs.cpSync(`${monitor.DestinationDirectory}/${file}`, `${monitor.DestinationDirectory}/current/${file}`, { recursive: true, force: true})
                        });

                        this.cache.set(monitor.Profile, cacheValue);
    
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

    syncProfileFiles(profile: string) {
        let monitor = this.monitors.find(x => x.Profile == profile);
        if (!monitor) {
            return;
        }
        this.syncMonitorFiles(monitor);
    }

    syncMonitorFiles(monitor: MonitorDetails) {
        monitor.CopyFiles.forEach((file) => {
            let source = `${monitor.DestinationDirectory}/${file}`;
            let destination = `${monitor.DestinationDirectory}/current/${file}`;

            let sourceDate : Date = new Date();
            let destinationDate : Date = new Date();
            fs.utimesSync(source, new Date(), sourceDate);
            fs.utimesSync(destination, new Date(), destinationDate);

            if (sourceDate != destinationDate) {
                Logger.info(`Copying ${source} to ${destination}`);
                fs.cpSync(source, destination, { recursive: true, force: true})
            }
            
        });
    }
}

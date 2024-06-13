import * as dotenv from "dotenv";
dotenv.config();

const DockerComposePath = process.env.DOCKER_COMPOSE_PATH;
const AutostartProfiles = process.env.AUTOSTART_PROFILES?.split(",") ?? [];
const AutostartMonitorProfiles = process.env.AUTOSTART_MONITOR_PROFILES?.split(",") ?? [];
const MonitorConfigPath = process.env.MONITOR_CONFIG_PATH;
const MonitorCronSchedule = process.env.MONITOR_CRON_SCHEDULE ?? '*/15 * * * *';
const ApiPort = Number(process.env.API_PORT ?? "3000");

export {
    DockerComposePath,
    AutostartProfiles,
    AutostartMonitorProfiles,
    MonitorConfigPath,
    MonitorCronSchedule,
    ApiPort
}
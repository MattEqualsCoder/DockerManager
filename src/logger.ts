import winston from 'winston';
import { format } from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';

const LogFormat = format.combine(
    format.timestamp({
        format: 'YYYY-MM-DD HH:mm:ss',
    }),
    format.printf((info) =>
        JSON.stringify({
            t: info.timestamp,
            l: info.level,
            m: info.message,
            s: info.splat !== undefined ? `${info.splat}` : '',
        }) + ','
    )
);

const Logger = winston.createLogger({
    level: 'info',
    format: LogFormat,
    transports: [
        new DailyRotateFile({
            filename: `../logs/log_%DATE%.log`,
            datePattern: 'yyyy-MM-DD',
            maxFiles: 30
        }),
    ],
});

if (process.env.NODE_ENV !== 'production') {
    Logger.add(new winston.transports.Console({
        format: LogFormat
    }));
}

export {
    Logger,
    LogFormat
}
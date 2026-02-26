export interface TuiTheme {
    name: 'leion-pro';
    highContrast: boolean;
    colors: {
        fg: string;
        muted: string;
        accent: string;
        accentAlt: string;
        panelBorder: string;
        panelBorderActive: string;
        ok: string;
        warn: string;
        err: string;
        info: string;
        tabActiveBg: string;
        tabActiveFg: string;
        statusBg: string;
        statusFg: string;
        paletteBorder: string;
    };
    symbols: {
        pointer: string;
        bullet: string;
        separator: string;
        ok: string;
        warn: string;
        err: string;
        info: string;
    };
}

export function createTheme(highContrast: boolean): TuiTheme {
    if (highContrast) {
        return {
            name: 'leion-pro',
            highContrast: true,
            colors: {
                fg: 'white',
                muted: 'gray',
                accent: 'cyanBright',
                accentAlt: 'yellowBright',
                panelBorder: 'white',
                panelBorderActive: 'cyanBright',
                ok: 'greenBright',
                warn: 'yellowBright',
                err: 'redBright',
                info: 'blueBright',
                tabActiveBg: 'white',
                tabActiveFg: 'black',
                statusBg: 'white',
                statusFg: 'black',
                paletteBorder: 'yellowBright'
            },
            symbols: {
                pointer: '▶',
                bullet: '•',
                separator: '│',
                ok: '●',
                warn: '▲',
                err: '✖',
                info: '◆'
            }
        };
    }

    return {
        name: 'leion-pro',
        highContrast: false,
        colors: {
            fg: 'white',
            muted: 'gray',
            accent: 'cyan',
            accentAlt: 'magentaBright',
            panelBorder: 'blue',
            panelBorderActive: 'cyan',
            ok: 'green',
            warn: 'yellow',
            err: 'red',
            info: 'cyanBright',
            tabActiveBg: 'cyan',
            tabActiveFg: 'black',
            statusBg: 'gray',
            statusFg: 'white',
            paletteBorder: 'magenta'
        },
        symbols: {
            pointer: '▸',
            bullet: '•',
            separator: '│',
            ok: '●',
            warn: '▲',
            err: '✖',
            info: '◆'
        }
    };
}

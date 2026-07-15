import {AreaExtractor, Bulletin, BulletinInfo, Cyclone, Landmass, PagasaParserSource, TCWSLevels} from "pagasa-parser";
import * as childProcess from "child_process";
import * as path from "path";
import * as url from "url";
import {search, searchAll} from "./Utilities";
import type {TabulaJSONOutput} from "./Tabula";

export default class PagasaParserPDFSource extends PagasaParserSource {

    /**
     * Loads in the PDF from the given path.
     *
     * @param path The string to a PDF.
     */
    constructor(private path: string) {
        super();
        try {
            childProcess.execFileSync("java", ["-version"], { stdio: "ignore" });
        } catch (e) {
            throw new Error("Cannot find Java in PATH. Java is required for this package to function.");
        }
    }

    tabulaStreamData: TabulaJSONOutput;
    tabulaLatticeData: TabulaJSONOutput;

    private async runTabula(mode: "stream" | "lattice"): Promise<TabulaJSONOutput> {
        const startedAt = Date.now();
        const modeFlag = mode === "stream" ? "-t" : "-l";
        const tabula = childProcess.spawn("java", [
            "-Dfile.encoding=UTF8", "-jar", path.resolve(__dirname, "..", "bin", "tabula.jar"),
            "-p", "all", modeFlag, "-f", "JSON", this.path
        ]);
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        const configuredTimeout = Number(process.env.PAGASA_PARSER_TABULA_TIMEOUT_MS ?? 45000);
        const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
            ? configuredTimeout
            : 45000;
        let timedOut = false;
        const timeout = setTimeout(() => {
            timedOut = true;
            tabula.kill("SIGKILL");
        }, timeoutMs);

        tabula.stdout.on("data", (data) => stdoutChunks.push(Buffer.from(data)));
        tabula.stderr.on("data", (data) => stderrChunks.push(Buffer.from(data)));

        return new Promise<TabulaJSONOutput>((resolve, reject) => {
            tabula.on("error", (error) => {
                clearTimeout(timeout);
                this.logTabula(mode, "start_failed", startedAt, error.message);
                reject(new Error(`Unable to start Tabula ${mode} extraction: ${error.message}`));
            });
            tabula.on("close", (code) => {
                clearTimeout(timeout);
                const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
                if (timedOut) {
                    this.logTabula(mode, "timeout", startedAt);
                    reject(new Error(`Tabula ${mode} extraction timed out after ${timeoutMs}ms.`));
                    return;
                }
                if (code !== 0) {
                    this.logTabula(mode, "failed", startedAt, stderr);
                    reject(new Error(
                        `Tabula ${mode} extraction failed with exit code ${code}` +
                        `${stderr ? `: ${stderr}` : "."}`
                    ));
                    return;
                }

                const output = Buffer.concat(stdoutChunks).toString("utf8");
                try {
                    const parsed = JSON.parse(output);
                    this.logTabula(mode, "succeeded", startedAt);
                    resolve(parsed);
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    this.logTabula(mode, "invalid_json", startedAt, message);
                    reject(new Error(`Tabula ${mode} extraction returned invalid JSON: ${message}`));
                }
            });
        });
    }

    private logTabula(
        mode: "stream" | "lattice",
        status: string,
        startedAt: number,
        detail?: string
    ): void {
        console.log(JSON.stringify({
            event: "pagasa_parser.tabula",
            file: path.basename(this.path),
            mode,
            status,
            durationMs: Date.now() - startedAt,
            detail: detail?.replace(/\s+/g, " ").slice(0, 300)
        }));
    }

    async getTabulaStreamData(): Promise<TabulaJSONOutput> {
        if (this.tabulaStreamData != null)
            return this.tabulaStreamData;

        return this.tabulaStreamData = await this.runTabula("stream");
    }

    async getTabulaLatticeData(): Promise<TabulaJSONOutput> {
        if (this.tabulaLatticeData != null)
            return this.tabulaLatticeData;

        return this.tabulaLatticeData = await this.runTabula("lattice");
    }

    async getTabulaData(): Promise<[TabulaJSONOutput, TabulaJSONOutput]> {
        return Promise.all([
            this.getTabulaStreamData(),
            this.getTabulaLatticeData()
        ]);
    }

    async parse(): Promise<Bulletin> {
        const [tabulaStreamChunks, tabulaLatticeChunks] = await this.getTabulaData();

        return this.extract(tabulaStreamChunks, tabulaLatticeChunks);
    }

    extract(stream: TabulaJSONOutput, lattice: TabulaJSONOutput): Bulletin {
        const info = this.extractInfo(stream, lattice);
        const cyclone = this.extractCyclone(stream, lattice);
        const signals = this.extractSignals(stream, lattice);

        const now = new Date();
        const active = info.issued < now && now < info.expires;

        return { active, info, cyclone, signals };
    }

    extractInfo(stream: TabulaJSONOutput, lattice: TabulaJSONOutput): BulletinInfo {
        let final = false;
        const countCell = search(stream, /Tropical Cyclone Bulletin N[ro]\. (\d+)/gi);

        if (countCell.text?.endsWith("F"))
            final = true;

        let titleCell = countCell.next();

        while (titleCell.text.trim().length == 0)
            titleCell = titleCell.next();

        const issued = new Date(search(stream, /Issued(?:\sat)?\s(.+)$/gi).match[1] + " GMT+8");

        const timeSearch = search(stream, /next bulletin at (\d+):(\d+)\s(AM|PM)\s(.+?)(?:\.|$)/gi);
        let expireDate = new Date(issued.getTime());
        if (timeSearch == null) {
            expireDate = null;
            final = true;
        } else {
            const timeMatch = timeSearch.match;

            let dateWrapping = timeMatch[4] !== "today";
            const expiryHourPH = +timeMatch[1] + (timeMatch[3].toLowerCase() === "pm" ? 12 : 0);
            if (expiryHourPH - 8 < expireDate.getUTCHours()) {
                dateWrapping = true;
            }
            expireDate.setUTCHours(expiryHourPH - 8);
            expireDate.setUTCMinutes(+timeMatch[2]);

            if (dateWrapping)
                expireDate.setDate(expireDate.getDate() + 1);
        }

        return {
            title: `${countCell.text} for ${titleCell.text.replace(/“”/g, "")}`,
            count: +countCell.match[1],
            url: url.pathToFileURL(this.path).toString(),
            final: final,
            issued: issued,
            expires: expireDate,
            summary: lattice.filter(l => l.data.length > 0)[0].data[0][0].text
        };
    }

    extractCyclone(stream: TabulaJSONOutput, lattice: TabulaJSONOutput): Cyclone {
        const headerCell = search(stream, /Tropical Cyclone Bulletin N[ro]\. (\d+)/gi);
        if (headerCell == null)
            throw new Error("Unable to extract the tropical cyclone bulletin header from the PDF.");

        let titleCell = headerCell.next();

        while (titleCell != null && titleCell.text.trim().length == 0)
            titleCell = titleCell.next();

        if (titleCell == null)
            throw new Error("Unable to extract the tropical cyclone title from the PDF.");

        const title = titleCell.text.trim();
        const titleMatch = /^(?:(.*)\s|^)[“"]?([^()]+?)["”]?(?:\s\((.+?)\))?$/.exec(title);
        if (titleMatch == null)
            throw new Error(`Unable to extract tropical cyclone metadata from title: ${title}`);
        const [, category, name, internationalName] = titleMatch;

        // Some PAGASA bulletins omit one or both degree symbols (for example,
        // JOSIE TCB #3F uses "14.5°N, 134.6E"). Search both Tabula modes
        // because table extraction varies between PDF generator versions.
        const positionPattern = /([0-9]+(?:\.[0-9]+)?)\s*°?\s*([NS])\s*,?\s*([0-9]+(?:\.[0-9]+)?)\s*°?\s*([WE])/gi;
        const positionCell = search(lattice, positionPattern) ?? search(stream, positionPattern);
        if (positionCell == null)
            throw new Error("Unable to extract tropical cyclone center coordinates from the PDF.");

        const positionMatch = positionCell.match;
        const position = {
            lat: +positionMatch[1] * (positionMatch[2] === "S" ? -1 : 1),
            lon: +positionMatch[3] * (positionMatch[4] === "W" ? -1 : 1),
        };
        if (Math.abs(position.lat) > 90 || Math.abs(position.lon) > 180)
            throw new Error(`Extracted tropical cyclone coordinates are outside valid ranges: ${position.lat}, ${position.lon}`);

        const movementMatch = search(lattice, /present\s?movement(?:.*([\r\n]*.+))?/gi);
        let movementString: string;
        if (movementMatch) {
            if (movementMatch.match[1] != null && movementMatch.match[1].trim().length !== 0) {
                // Movement string is in same cell. Parse out.
                movementString = movementMatch.match[1].trim();
            } else {
                movementString = movementMatch.page.data[movementMatch.rowId + 1][0].text;
            }
        }

        return {
            name: name,
            internationalName: internationalName,
            category: category,
            prevailing: true,
            center: position,
            movement: movementString
        };
    }

    extractSignals(stream: TabulaJSONOutput, lattice: TabulaJSONOutput): TCWSLevels {
        const signals: TCWSLevels = { 1: null, 2: null, 3: null, 4: null, 5: null };

        const signalHeaders = searchAll(lattice, /^(\d)(?:.|[\r\n])+(?:winds?|hours\))/gi);
        for (const signalCell of signalHeaders) {
            const signal = +signalCell.match[1] as 1 | 2 | 3 | 4 | 5;

            /* +-------------+-------+---------+----------+
             * | signal cell | Luzon | Visayas | Mindanao |
             * +-------------+-------+---------+----------+
             *   signalCell    .next   .next     .next
             */

            const luzon = new AreaExtractor(signalCell.next().text).extractAreas();
            const visayas = new AreaExtractor(signalCell.next().next().text).extractAreas();
            const mindanao = new AreaExtractor(signalCell.next().next().next().text).extractAreas();

            signals[signal] = {
                areas: {
                    [Landmass.Luzon]: luzon,
                    [Landmass.Visayas]: visayas,
                    [Landmass.Mindanao]: mindanao
                }
            };
        }

        return signals;
    }

}

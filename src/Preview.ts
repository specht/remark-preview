"use strict"
import * as vscode from 'vscode';
import * as Constants from './Constants';
import * as fs from 'fs';
import * as path from 'path';
import { markdownCompiler } from './remarkConfig';
import * as frontmatter from 'remark-frontmatter';
import { htmlTemplate } from './html-template';
import { disposeAll } from './utils/dispose';

export default class Preview {

    panel: vscode.WebviewPanel;
    editor: any;
    line: number;
    disableWebViewStyling: boolean;
    context: vscode.ExtensionContext;
    remarkViewerConfig: any;
    private _resource: vscode.Uri;
    private readonly disposables: vscode.Disposable[] = [];
    private _disposed: boolean = false;
    private readonly _onDisposeEmitter = new vscode.EventEmitter<void>();
    public readonly onDispose = this._onDisposeEmitter.event;
    private readonly _onDidChangeViewStateEmitter = new vscode.EventEmitter<vscode.WebviewPanelOnDidChangeViewStateEvent>();

    //returns true if an html document is open
    constructor(context) {
        this.context = context;
    };

    preprocess_agr(s) {
        // mark agr spans
        let t = '';
        let within = false;
        for (let i = 0; i < s.length; i++) {
            let c = s.charAt(i);
            c = c.normalize('NFD');
            let n = c.codePointAt(0);
            if (within) {
                if (!(n >= 0x0300 && n <= 0x03ff)) {
                    within = false;
                    t += '</span>';
                }
                t += c;
                continue;
            }
            if (!within) {
                if (n >= 0x0300 && n <= 0x03ff) {
                    within = true;
                    t += "<span class='agr'>";
                }
                t += c;
            }
        }

        s = s.replace(/~/g, "<span class='hspace'></span>");
        s = s.replace(/  \n/g, "<br>");

        s = s.replace(/\\begin{box}/g, "<div class='table'><div markdown='1' class='box'>\n\n");
        s = s.replace(/\\end{box}/g, "\n\n</div></div>");
        s = s.replace(/\\begin{frame}/g, "<div class='table'><div markdown='1' class='frame'>\n\n");
        s = s.replace(/\\end{frame}/g, "\n\n</div></div>");

        s = s.replace(/_(.+?)_/g, function(a, b) {
            return `<u>${b}</u>`;
        });
        s = s.replace(/%(.+?)%/g, function(a, b) {
            return `<em>${b}</em>`;
        });
        s = s.replace(/\*(.+?)\*/g, function(a, b) {
            return `<strong>${b}</strong>`;
        });

        // parse tables
        s = s.replace(/\\begin\{table\}\{(.+?)\\end\{table\}/sg, function(a, x) {
            x = x.replace('\\begin{table}{', '');
            let cols = parseInt(x);
            x = x.replace(/\d+\}/, '');
            x = x.replace('\\end{table}', '');
            x = x.trim();
            let cells = x.split('\\\\');
            cells.pop();
            let result = "";
            result += "<div class='table'><table>";
            let i = 0;
            let rowspan_items = [];
            for (let c of cells) {
                c = c.trim();
                if (c.trim() === '=') {
                    result += `<tr><td class='empty_row' colspan='${cols}' style='border: none;'></td></tr>`
                    continue;
                }
                let classes = [];
                if (i % cols === 0)
                    result += "<tr>";
                let colspan = 1;
                let rowspan = 1;
                while (true) {
                    if (c.trim().match(/^x(\d+)/) !== null) {
                        colspan = parseInt(c.trim().match(/^x(\d+)/)[1]);
                        c = c.trim().replace(/^x(\d+)/, '');
                    } else if (c.trim().match(/^y(\d+)/) !== null) {
                        rowspan = parseInt(c.trim().match(/^y(\d+)/)[1]);
                        for (let i = 0; i < rowspan; i++) {
                            if (rowspan_items.length <= i) rowspan_items.push(0);
                            if (i > 0) rowspan_items[i] += colspan;
                        }
                        c = c.trim().replace(/^y(\d+)/, '');
                    } else if (c.trim().charAt(0) === '@') {
                        c = c.trim().substr(1).trim();
                        classes.push('noborder');
                    } else if (c.trim().charAt(0) === '!') {
                        c = c.trim().substr(1).trim();
                        classes.push('center');
                    } else {
                        break;
                    }
                }

                c = c.trim();

                let tag = 'td';
                if (c[0] === '>') {
                    c = c.substr(1).trim();
                    tag = 'th';
                }

                result += `<${tag}`;
                if (colspan != 1) result += ` colspan='${colspan}'`;
                if (rowspan != 1) result += ` rowspan='${rowspan}'`;
                if (classes.length > 0) result += ` class='${classes.join(' ')}'`;
                result += `>${c.trim()}`;
                result += '&#x200b;';
                result += `</${tag}>\n`;
                for (let k = 0; k < colspan; k++) {
                    if (i % cols == cols - 1 - (rowspan_items[0] || 0)) {
                        result += "</tr>";
                        rowspan_items.shift();
                        i = -1;
                    }
                    i += 1;
                }
            }
            result += "</table></div>";
            return result;
        });

        return s;
    }

    async handleTextDocumentChange() {
        this.remarkViewerConfig = vscode.workspace.getConfiguration('remark');
        if (vscode.window.activeTextEditor && this.checkDocumentIsMarkdown(true) && this.panel && this.panel !== undefined) {
            let currentHTMLtext = vscode.window.activeTextEditor.document.getText();
            currentHTMLtext = this.preprocess_agr(currentHTMLtext);
            const filePaths = vscode.window.activeTextEditor.document.fileName.split('/');
            const fileName = filePaths[filePaths.length - 1]
            this.panel.title = `[Preview] ${fileName}`;
            const md = markdownCompiler().use(frontmatter, { type: 'yaml', marker: '-' });
            let currentHTMLContent = await md.process(currentHTMLtext);
            this._resource = vscode.window.activeTextEditor.document.uri;
            this.panel.webview.html = this.getWebviewContent(currentHTMLContent.contents, fileName);
            if (vscode.window.activeTextEditor.document.languageId === 'markdown' && this.remarkViewerConfig.get('preview.scrollPreviewWithEditor')) {
                this.postMessage({
                    type: 'scroll',
                    line: vscode.window.activeTextEditor.visibleRanges,
                    source: vscode.window.activeTextEditor.document
                });
            }
            //console.log(this.panel.webview.html);
        }
    }

    getWebviewContent(html, fileName) {
        const filePaths = fileName.split('/');
        fileName = filePaths[filePaths.length - 1];
        const reg = /<img src\s*=\s*"(.+?)"/g;
        var m;
        do {
            m = reg.exec(html);
            if (m) {
                let imagePath = m[1].split('/');
                let imageName = imagePath[imagePath.length - 1];
                let vsCodeImagePath = this.getDynamicContentPath(imageName);
                html = html?.replace(m[0], m[0].replace(m[1], vsCodeImagePath));
            }
        } while (m);
        return htmlTemplate(this.context, this.panel, html, fileName);
    }

    getDynamicContentPath(filepath) {
        const onDiskPath = vscode.Uri.file(path.join(vscode.workspace.rootPath, 'content/media', filepath))
        const styleSrc = this.panel.webview.asWebviewUri(onDiskPath);
        return styleSrc
    }

    getDocumentType(): string {
        let languageId = vscode.window.activeTextEditor.document.languageId.toLowerCase();
        return languageId;
    }

    checkDocumentIsMarkdown(showWarning: boolean): boolean {
        let result = this.getDocumentType() === "markdown";
        if (!result && showWarning) {
            vscode.window.showInformationMessage(Constants.ErrorMessages.NO_MARKDOWN);
        }
        return result;
    }

    async initMarkdownPreview(viewColumn: number) {
        let proceed = this.checkDocumentIsMarkdown(true);
        if (proceed) {
            const filePaths = vscode.window.activeTextEditor.document.fileName.split('/');
            const fileName = filePaths[filePaths.length - 1];
            // Create and show a new webview
            this.panel = vscode.window.createWebviewPanel(
                'liveHTMLPreviewer',
                '[Preview] ' + fileName,
                viewColumn,
                {
                    // Enable scripts in the webview
                    enableScripts: true,
                    retainContextWhenHidden: true,
                    // And restrict the webview to only loading content from our extension's `assets` directory.
                    localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, 'assets')), vscode.Uri.file(path.join(vscode.workspace.rootPath, 'content/media'))]
                }
            );
            this.panel.iconPath = this.iconPath
            this._disposed = false;

            // And set its HTML content
            this.editor = vscode.window.activeTextEditor;
            await this.handleTextDocumentChange.call(this);

            vscode.workspace.onDidChangeTextDocument(await this.handleTextDocumentChange.bind(this));
            vscode.workspace.onDidChangeConfiguration(await this.handleTextDocumentChange.bind(this));
            vscode.workspace.onDidSaveTextDocument(await this.handleTextDocumentChange.bind(this));
            vscode.window.onDidChangeActiveTextEditor(await this.handleTextDocumentChange.bind(this));

            vscode.window.onDidChangeTextEditorVisibleRanges(({ textEditor, visibleRanges }) => {
                this.remarkViewerConfig = vscode.workspace.getConfiguration('remark');
                if (textEditor.document.languageId === 'markdown' && this.remarkViewerConfig.get('preview.scrollPreviewWithEditor')) {
                    this.postMessage({
                        type: 'scroll',
                        line: visibleRanges,
                        source: textEditor.document
                    });
                }
            })

            this.panel.webview.onDidReceiveMessage(e => {
                this.onDidScrollPreview(e.body.line);
            });

            this.panel.onDidDispose(() => {
                this.dispose();
            }, null, this.disposables);
        }
    }

    private onDidScrollPreview(line: number) {
        this.line = line;
        for (const editor of vscode.window.visibleTextEditors) {
            if (!this.isPreviewOf(editor.document.uri)) {
                continue;
            }
            const sourceLine = Math.floor(line);
            const fraction = line - sourceLine;
            const text = editor.document.lineAt(sourceLine).text;
            const start = Math.floor(fraction * text.length);
            editor.revealRange(
                new vscode.Range(sourceLine, start, sourceLine + 1, 0),
                vscode.TextEditorRevealType.AtTop);
        }
    }

    private isPreviewOf(resource: vscode.Uri): boolean {
        return this._resource.fsPath === resource.fsPath;
    }

    private get iconPath() {
        const root = path.join(this.context.extensionPath, 'assets/icons');
        return {
            light: vscode.Uri.file(path.join(root, 'Preview.svg')),
            dark: vscode.Uri.file(path.join(root, 'Preview_inverse.svg'))
        };
    }

    private postMessage(msg: any) {
        if (!this._disposed) {
            this.panel.webview.postMessage(msg);
        }
    }

    public dispose() {
        if (this._disposed) {
            return;
        }

        this._disposed = true;
        this._onDisposeEmitter.fire();

        this._onDisposeEmitter.dispose();
        this.panel.dispose();

        disposeAll(this.disposables);
    }
}
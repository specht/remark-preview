import * as vscode from 'vscode';
import * as path from 'path';

export const htmlTemplate = (context, panel, html, fileName) => {

    const nonce = getNonce();
    return `<!doctype html>
            <html lang="de">
            <head>
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${panel.webview.cspSource} 'self' 'unsafe-inline'; script-src 'nonce-${nonce}'; style-src ${panel.webview.cspSource} 'self' 'unsafe-inline'; font-src ${panel.webview.cspSource}">

                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
                <meta id="vscode-html-preview-data" data-settings="${JSON.stringify(getInitialState()).replace(/"/g, '&quot;')}">
                <script nonce="${nonce}" src="${getDynamicContentPath(context, panel, 'assets/js/main.js')}"></script>
                <script nonce="${nonce}" src="${getDynamicContentPath(context, panel, 'assets/js/index.js')}"></script>
                <link rel="stylesheet" type="text/css" href="${getDynamicContentPath(context, panel, 'assets/css/main.css')}">
            </head>
            <body>
                ${html}     
            </body>
        </html>`
};

function getInitialState() {
    return {
        source: vscode.window.activeTextEditor.document.uri.toString(),
        visibleRange: vscode.window.activeTextEditor.visibleRanges,
        lineCount: vscode.window.activeTextEditor.document.lineCount,
    };
}
function getDynamicContentPath(context, panel, filepath) {
    const onDiskPath = vscode.Uri.file(path.join(context.extensionPath, filepath))
    const styleSrc = panel.webview.asWebviewUri(onDiskPath);
    return styleSrc
}

function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
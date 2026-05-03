
export const escapeHtml = (value: string): string => {
    const replacements: Record<string, string> = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    };

    return value.replace(/[&<>"']/g, char => replacements[char]);
};

const stripWrappingCodeFence = (value: string): string => {
    const trimmed = value.trim();
    const match = trimmed.match(/^```(?:html|markdown|md)?\s*([\s\S]*?)\s*```$/i);
    return match ? match[1].trim() : value;
};

const processInlineFormatting = (text: string): string => {
    return escapeHtml(text)
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.*?)\*/g, '<em>$1</em>');
};

const sanitizeTableAttributeValue = (value: string | null): string | null => {
    if (!value) return null;
    const normalized = value.trim();
    return /^\d{1,2}$/.test(normalized) ? normalized : null;
};

const sanitizeHtmlTable = (html: string): string | null => {
    if (typeof DOMParser === 'undefined') return null;

    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const table = doc.querySelector('table');
    if (!table) return null;

    const allowedTags = new Set([
        'table',
        'thead',
        'tbody',
        'tfoot',
        'tr',
        'th',
        'td',
        'caption',
        'colgroup',
        'col',
        'p',
        'strong',
        'em',
        'b',
        'i',
        'br',
    ]);

    const sanitizeNode = (node: Node): string => {
        if (node.nodeType === 3) return escapeHtml(node.textContent || '');
        if (node.nodeType !== 1) return '';

        const element = node as Element;
        const tag = element.tagName.toLowerCase();
        const children = Array.from(element.childNodes).map(sanitizeNode).join('');

        if (!allowedTags.has(tag)) return children;

        const attrs: string[] = [];
        if (tag === 'td' || tag === 'th') {
            const colspan = sanitizeTableAttributeValue(element.getAttribute('colspan'));
            const rowspan = sanitizeTableAttributeValue(element.getAttribute('rowspan'));
            if (colspan) attrs.push(` colspan="${colspan}"`);
            if (rowspan) attrs.push(` rowspan="${rowspan}"`);
        }

        if (tag === 'br' || tag === 'col') return `<${tag}${attrs.join('')}>`;
        return `<${tag}${attrs.join('')}>${children}</${tag}>`;
    };

    return sanitizeNode(table);
};

const splitMarkdownTableRow = (row: string): string[] => {
    return row
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map(cell => cell.trim());
};

const isMarkdownTableSeparator = (row: string): boolean => {
    const cells = splitMarkdownTableRow(row);
    return cells.length > 1 && cells.every(cell => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, '')));
};

export const parseMarkdownToHtml = (markdown: string): string => {
    if (!markdown) return '';

    const normalizedMarkdown = stripWrappingCodeFence(markdown);
    const trimmedMarkdown = normalizedMarkdown.trim();
    if (/^<table[\s\S]*<\/table>$/i.test(trimmedMarkdown)) {
        const sanitizedTable = sanitizeHtmlTable(trimmedMarkdown);
        if (sanitizedTable) return sanitizedTable;
    }

    const lines = normalizedMarkdown.split('\n');
    const htmlLines: string[] = [];
    let inList = false;
    let listType = ''; // 'ul' or 'ol'

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const trimmedLine = line.trim();

        if (
            trimmedLine.includes('|') &&
            index + 1 < lines.length &&
            isMarkdownTableSeparator(lines[index + 1])
        ) {
            if (inList) {
                htmlLines.push(`</${listType}>`);
                inList = false;
            }

            const headers = splitMarkdownTableRow(trimmedLine);
            const bodyRows: string[][] = [];
            let rowIndex = index + 2;

            while (rowIndex < lines.length && lines[rowIndex].trim().includes('|')) {
                const row = lines[rowIndex].trim();
                if (!row || isMarkdownTableSeparator(row)) break;
                bodyRows.push(splitMarkdownTableRow(row));
                rowIndex += 1;
            }

            const headerHtml = headers.map(cell => `<th>${processInlineFormatting(cell)}</th>`).join('');
            const bodyHtml = bodyRows
                .map(row => `<tr>${row.map(cell => `<td>${processInlineFormatting(cell)}</td>`).join('')}</tr>`)
                .join('');

            htmlLines.push(`<table><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>`);
            index = rowIndex - 1;
            continue;
        }

        // Handle headings
        if (trimmedLine.startsWith('#')) {
            if (inList) {
                htmlLines.push(`</${listType}>`);
                inList = false;
            }
            const level = trimmedLine.match(/^#+/)?.[0].length || 0;
            if (level > 0 && level <= 4) {
                const content = trimmedLine.substring(level).trim();
                htmlLines.push(`<h${level}>${processInlineFormatting(content)}</h${level}>`);
                continue;
            }
        }

        // Handle unordered list items (support for *, -, and •)
        if (trimmedLine.startsWith('* ') || trimmedLine.startsWith('- ') || trimmedLine.startsWith('• ')) {
            const currentListType = 'ul';
            if (!inList) {
                htmlLines.push(`<ul>`);
                inList = true;
                listType = currentListType;
            } else if (listType !== currentListType) {
                htmlLines.push(`</${listType}>`);
                htmlLines.push(`<ul>`);
                listType = currentListType;
            }
            // Determine substring length based on the marker char (all are 1 char + space = 2)
            const content = trimmedLine.substring(2);
            htmlLines.push(`<li>${processInlineFormatting(content)}</li>`);
            continue;
        }

        // Handle ordered list items
        const orderedMatch = trimmedLine.match(/^(\d+)\. /);
        if (orderedMatch) {
            const currentListType = 'ol';
             if (!inList) {
                htmlLines.push(`<ol>`);
                inList = true;
                listType = currentListType;
            } else if (listType !== currentListType) {
                htmlLines.push(`</${listType}>`);
                htmlLines.push(`<ol>`);
                listType = currentListType;
            }
            const content = trimmedLine.substring(orderedMatch[0].length);
            htmlLines.push(`<li>${processInlineFormatting(content)}</li>`);
            continue;
        }

        // Close any open list if the line is not a list item
        if (inList) {
            htmlLines.push(`</${listType}>`);
            inList = false;
        }

        // Handle paragraphs (any non-empty line that's not a heading or list item)
        if (trimmedLine) {
            htmlLines.push(`<p>${processInlineFormatting(trimmedLine)}</p>`);
        }
    }

    // Close any remaining open list
    if (inList) {
        htmlLines.push(`</${listType}>`);
    }

    return htmlLines.join('\n');
};


export const getNodeText = (node: any): string => {
  if (!node) {
    return '';
  }
  if (node.type === 'text' && node.text) {
    return node.text;
  }
  if (Array.isArray(node.content)) {
    return node.content.map(getNodeText).join('');
  }
  return '';
};

export const getNodeSizeFromJSON = (nodeJSON: any): number => {
    if (!nodeJSON || typeof nodeJSON !== 'object') {
        return 0;
    }

    if (nodeJSON.type === 'text') {
        return nodeJSON.text?.length || 0;
    }
    
    if (['hardBreak', 'horizontalRule'].includes(nodeJSON.type)) {
        return 1;
    }
    
    let size = 2; // For open and close tags for non-leaf/wrapper nodes
    
    if (Array.isArray(nodeJSON.content)) {
        for (const child of nodeJSON.content) {
            size += getNodeSizeFromJSON(child);
        }
    }
    
    return size;
};

export const getWordCount = (text: string): number => {
  return text.trim().split(/\s+/).filter(Boolean).length;
};

export const generateToc = (editorInstance: import('@tiptap/core').Editor | null): string => {
    if (!editorInstance) return '';
    const tocItems: string[] = [];
    let introAdded = false;
    editorInstance.state.doc.forEach(node => {
        if (!introAdded && node.type.name !== 'heading' && node.textContent.trim().length > 0) {
            tocItems.push("- المقدمة");
            introAdded = true;
        }
        if (node.type.name === 'heading') {
            if (!introAdded) { tocItems.push("- المقدمة"); introAdded = true; }
            tocItems.push(`${'  '.repeat(node.attrs.level - 1)}- H${node.attrs.level}: ${node.textContent}`);
        }
    });
    if (!introAdded && editorInstance.state.doc.textContent.trim().length > 0) {
        tocItems.push("- المقدمة");
    }
    return tocItems.join('\n');
};

export const getPrecedingHeading = (editor: any, position: number): string => {
    if (!editor) return '';
    let headingText = '';
    // Iterate nodes up to the position to find the last heading
    editor.state.doc.nodesBetween(0, position, (node: any) => {
        if (node.type.name === 'heading') {
            headingText = node.textContent;
        }
    });
    return headingText;
};

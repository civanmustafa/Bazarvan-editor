
export const parseMarkdownToHtml = (markdown: string): string => {
    if (!markdown) return '';

    const lines = markdown.split('\n');
    const htmlLines: string[] = [];
    let inList = false;
    let listType = ''; // 'ul' or 'ol'

    const processInlineFormatting = (text: string): string => {
        return text
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.*?)\*/g, '<em>$1</em>');
    };

    for (const line of lines) {
        const trimmedLine = line.trim();

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

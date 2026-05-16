/**
 * CSS Inlining Utility for HTML Emails
 *
 * Converts CSS from `<style>` tags to inline `style` attributes for better
 * email client compatibility. Most email clients strip `<style>` tags but
 * support inline styles.
 */

interface ParsedRule {
  selector: string;
  properties: Map<string, { value: string; important: boolean }>;
  specificity: number;
}

interface InlineOptions {
  inlineCss?: boolean;
  addDefaults?: boolean;
  removeStyleTags?: boolean;
}

const EMAIL_DEFAULT_CSS = `
  table { border-collapse: collapse; }
  img { display: block; border: 0; outline: none; text-decoration: none; }
  body { margin: 0; padding: 0; }
  p { margin: 0; padding: 0; }
`;

/**
 * Parses CSS property string into a map of properties
 */
function parseProperties(cssText: string): Map<string, { value: string; important: boolean }> {
  const properties = new Map<string, { value: string; important: boolean }>();
  
  const declarations = cssText.split(';').filter(d => d.trim());
  
  for (const decl of declarations) {
    const colonIndex = decl.indexOf(':');
    if (colonIndex === -1) continue;
    
    const prop = decl.slice(0, colonIndex).trim().toLowerCase();
    let value = decl.slice(colonIndex + 1).trim();
    
    const important = value.endsWith('!important');
    if (important) {
      value = value.slice(0, -10).trim();
    }
    
    if (prop && value) {
      properties.set(prop, { value, important });
    }
  }
  
  return properties;
}

/**
 * Calculates selector specificity (simplified)
 * Higher = more specific
 */
function calculateSpecificity(selector: string): number {
  let specificity = 0;
  
  const parts = selector.split(/\s+/);
  
  for (const part of parts) {
    const idMatches = part.match(/#/g);
    const classMatches = part.match(/\./g);
    const attrMatches = part.match(/\[/g);
    
    specificity += (idMatches?.length || 0) * 100;
    specificity += (classMatches?.length || 0) * 10;
    specificity += (attrMatches?.length || 0) * 10;
    
    const cleanPart = part.replace(/[.#[:].*/g, '');
    if (cleanPart && /^[a-z]/i.test(cleanPart)) {
      specificity += 1;
    }
  }
  
  return specificity;
}

/**
 * Checks if a selector should be skipped (media queries, pseudo-elements, etc.)
 */
function shouldSkipSelector(selector: string): boolean {
  const skipPatterns = [
    /@media/i,
    /@keyframes/i,
    /@font-face/i,
    /@import/i,
    /@supports/i,
    /::/,
    /:hover/i,
    /:active/i,
    /:focus/i,
    /:visited/i,
    /:target/i,
    /:before/i,
    /:after/i,
    /:first-child/i,
    /:last-child/i,
    /:nth-child/i,
    /:not\(/i,
  ];
  
  return skipPatterns.some(pattern => pattern.test(selector));
}

/**
 * Extracts all CSS rules from style tags
 */
function extractRules(html: string): { rules: ParsedRule[]; cleanHtml: string } {
  const rules: ParsedRule[] = [];
  
  const styleRegex = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  
  const cleanHtml = html.replace(styleRegex, (match, cssContent) => {
    const cleanCss = cssContent
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\s+/g, ' ')
      .trim();
    
    const ruleRegex = /([^{}]+)\{([^{}]+)\}/g;
    let ruleMatch;
    
    while ((ruleMatch = ruleRegex.exec(cleanCss)) !== null) {
      const selectors = ruleMatch[1].split(',').map(s => s.trim());
      const properties = parseProperties(ruleMatch[2]);
      
      for (const selector of selectors) {
        if (!selector || shouldSkipSelector(selector)) continue;
        
        rules.push({
          selector,
          properties,
          specificity: calculateSpecificity(selector),
        });
      }
    }
    
    return match;
  });
  
  rules.sort((a, b) => a.specificity - b.specificity);
  
  return { rules, cleanHtml };
}

/**
 * Parses existing inline styles into a map
 */
function parseInlineStyles(styleAttr: string): Map<string, { value: string; important: boolean }> {
  const styles = new Map<string, { value: string; important: boolean }>();
  
  if (!styleAttr) return styles;
  
  const declarations = styleAttr.split(';').filter(d => d.trim());
  
  for (const decl of declarations) {
    const colonIndex = decl.indexOf(':');
    if (colonIndex === -1) continue;
    
    const prop = decl.slice(0, colonIndex).trim().toLowerCase();
    let value = decl.slice(colonIndex + 1).trim();
    
    const important = value.endsWith('!important');
    if (important) {
      value = value.slice(0, -10).trim();
    }
    
    if (prop && value) {
      styles.set(prop, { value, important });
    }
  }
  
  return styles;
}

/**
 * Converts styles map to inline style string
 */
function stylesToString(styles: Map<string, { value: string; important: boolean }>): string {
  const parts: string[] = [];
  
  styles.forEach((prop, name) => {
    const suffix = prop.important ? '!important' : '';
    parts.push(`${name}: ${prop.value}${suffix}`);
  });
  
  return parts.join('; ');
}

/**
 * Checks if an element matches a simple selector
 */
function matchesSimpleSelector(element: string, classes: string[], id: string | null, selector: string): boolean {
  let selClasses: string[] = [];
  let selId: string | null = null;
  let selElement: string | null = null;
  
  const idMatch = selector.match(/#([a-zA-Z0-9_-]+)/);
  if (idMatch) selId = idMatch[1];
  
  const classMatches = selector.match(/\.[a-zA-Z0-9_-]+/g);
  if (classMatches) {
    selClasses = classMatches.map(c => c.slice(1));
  }
  
  const elementMatch = selector.match(/^[a-zA-Z][a-zA-Z0-9]*/);
  if (elementMatch) selElement = elementMatch[0].toLowerCase();
  
  if (selElement && element !== selElement) return false;
  if (selId && id !== selId) return false;
  if (selClasses.length > 0) {
    for (const selClass of selClasses) {
      if (!classes.includes(selClass)) return false;
    }
  }
  
  return true;
}

/**
 * Checks if an element matches a selector (handles descendant combinators)
 */
function matchesSelector(
  element: string,
  classes: string[],
  id: string | null,
  ancestors: Array<{ element: string; classes: string[]; id: string | null }>,
  selector: string
): boolean {
  const parts = selector.split(/\s+/).map(s => s.trim());
  
  if (parts.length === 1) {
    return matchesSimpleSelector(element, classes, id, parts[0]);
  }
  
  if (!matchesSimpleSelector(element, classes, id, parts[parts.length - 1])) {
    return false;
  }
  
  const ancestorSelectors = parts.slice(0, -1).reverse();
  let ancestorIndex = 0;
  
  for (const ancestorSel of ancestorSelectors) {
    let found = false;
    
    while (ancestorIndex < ancestors.length) {
      const anc = ancestors[ancestorIndex];
      ancestorIndex++;
      
      if (matchesSimpleSelector(anc.element, anc.classes, anc.id, ancestorSel)) {
        found = true;
        break;
      }
    }
    
    if (!found) return false;
  }
  
  return true;
}

/**
 * Extracts element info from a tag
 */
function parseTag(tag: string): { element: string; classes: string[]; id: string | null; styleAttr: string | null } {
  const elementMatch = tag.match(/<([a-zA-Z][a-zA-Z0-9]*)/);
  const element = elementMatch ? elementMatch[1].toLowerCase() : '';
  
  const classMatch = tag.match(/class=["']([^"']*)["']/);
  const classes = classMatch ? classMatch[1].split(/\s+/).filter(c => c) : [];
  
  const idMatch = tag.match(/id=["']([^"']*)["']/);
  const id = idMatch ? idMatch[1] : null;
  
  const styleMatch = tag.match(/style=["']([^"']*)["']/);
  const styleAttr = styleMatch ? styleMatch[1] : null;
  
  return { element, classes, id, styleAttr };
}

/**
 * Applies CSS rules to HTML elements
 */
function applyRules(html: string, rules: ParsedRule[], removeStyleTags: boolean): string {
  const tagStack: Array<{ element: string; classes: string[]; id: string | null }> = [];
  
  let result = html;
  
  const tagRegex = /<\/?([a-zA-Z][a-zA-Z0-9]*)[^>]*>/g;
  let match;
  
  const replacements: Array<{ start: number; end: number; replacement: string }> = [];
  
  while ((match = tagRegex.exec(result)) !== null) {
    const fullMatch = match[0];
    const tagName = match[1].toLowerCase();
    const isClosing = fullMatch.startsWith('</');
    const isSelfClosing = fullMatch.endsWith('/>') || ['img', 'br', 'hr', 'input', 'meta', 'link'].includes(tagName);
    
    if (isClosing) {
      const lastOpen = tagStack.pop();
      if (lastOpen && lastOpen.element !== tagName) {
        tagStack.push(lastOpen);
      }
    } else if (!isSelfClosing) {
      tagStack.push({ element: tagName, classes: [], id: null });
    }
    
    if (!isClosing && !isSelfClosing) {
      const tagStart = match.index;
      const tagEnd = tagStart + fullMatch.length;
      
      const { element, classes, id, styleAttr } = parseTag(fullMatch);
      
      tagStack[tagStack.length - 1] = { element, classes, id };
      
      const ancestors = tagStack.slice(0, -1);
      
      const mergedStyles = new Map<string, { value: string; important: boolean }>();
      
      for (const rule of rules) {
        if (matchesSelector(element, classes, id, ancestors, rule.selector)) {
          rule.properties.forEach((propValue, propName) => {
            const existing = mergedStyles.get(propName);
            
            if (!existing || propValue.important || (!existing.important && !propValue.important)) {
              mergedStyles.set(propName, propValue);
            }
          });
        }
      }
      
      if (styleAttr) {
        const existingStyles = parseInlineStyles(styleAttr);
        
        existingStyles.forEach((propValue, propName) => {
          const cssValue = mergedStyles.get(propName);
          
          if (!cssValue || propValue.important) {
            mergedStyles.set(propName, propValue);
          }
        });
      }
      
      if (mergedStyles.size > 0) {
        const newStyle = stylesToString(mergedStyles);
        
        let newTag: string;
        if (styleAttr) {
          newTag = fullMatch.replace(/style=["'][^"']*["']/, `style="${newStyle}"`);
        } else {
          const insertPos = fullMatch.indexOf(' ');
          if (insertPos === -1) {
            newTag = fullMatch.replace('>', ` style="${newStyle}">`);
          } else {
            newTag = fullMatch.slice(0, insertPos + 1) + `style="${newStyle}" ` + fullMatch.slice(insertPos + 1);
          }
        }
        
        replacements.push({ start: tagStart, end: tagEnd, replacement: newTag });
      }
    }
  }
  
  for (let i = replacements.length - 1; i >= 0; i--) {
    const { start, end, replacement } = replacements[i];
    result = result.slice(0, start) + replacement + result.slice(end);
  }
  
  if (removeStyleTags) {
    result = result.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  }
  
  return result;
}

/**
 * Inlines CSS from `<style>` tags into element style attributes.
 *
 * @param html - The HTML string to process
 * @param options - Configuration options
 * @returns HTML with inlined CSS
 */
export function inlineCss(html: string, options: { removeStyleTags?: boolean } = {}): string {
  const { removeStyleTags = true } = options;
  
  const { rules, cleanHtml } = extractRules(html);
  
  if (rules.length === 0) {
    return removeStyleTags ? cleanHtml : html;
  }
  
  return applyRules(cleanHtml, rules, removeStyleTags);
}

/**
 * Adds email-safe default CSS to HTML.
 *
 * @param html - The HTML string to process
 * @returns HTML with email defaults added
 */
export function addEmailDefaults(html: string): string {
  const hasStyleTag = /<style[^>]*>/i.test(html);
  
  if (hasStyleTag) {
    return html.replace(/<style[^>]*>/i, `<style>${EMAIL_DEFAULT_CSS}`);
  }
  
  const headMatch = html.match(/<head[^>]*>/i);
  if (headMatch) {
    return html.replace(headMatch[0], `${headMatch[0]}<style>${EMAIL_DEFAULT_CSS}</style>`);
  }
  
  const htmlMatch = html.match(/<html[^>]*>/i);
  if (htmlMatch) {
    return html.replace(htmlMatch[0], `${htmlMatch[0]}<head><style>${EMAIL_DEFAULT_CSS}</style></head>`);
  }
  
  return `<head><style>${EMAIL_DEFAULT_CSS}</style></head>${html}`;
}

/**
 * Prepares HTML for email by inlining CSS and adding defaults.
 *
 * @param html - The HTML string to process
 * @param options - Configuration options
 * @returns Fully prepared HTML for email
 */
export function prepareEmailHtml(
  html: string,
  options: InlineOptions = {}
): string {
  const {
    inlineCss: shouldInlineCss = true,
    addDefaults = true,
    removeStyleTags = true,
  } = options;
  
  let result = html;
  
  if (addDefaults) {
    result = addEmailDefaults(result);
  }
  
  if (shouldInlineCss) {
    result = inlineCss(result, { removeStyleTags });
  }
  
  return result;
}

export default prepareEmailHtml;

import {visit} from 'unist-util-visit';

const RULE_ID = 'no-unescaped-angle-brackets';

const createPositionForMatch = (node, matchIndex) => {
  const startPosition = node.position?.start;
  if (startPosition) {
    const startOffset = startPosition.offset;
    const offset =
      typeof startOffset === 'number' ? startOffset + matchIndex : undefined;
    const start = {
      line: startPosition.line,
      column: startPosition.column + matchIndex,
      offset,
    };
    const endOffset = typeof offset === 'number' ? offset + 1 : undefined;
    const end = {
      line: start.line,
      column: start.column + 1,
      offset: endOffset,
    };
    return {start, end};
  }
  return null;
};

const reportAngleBracket = (file, node, matchIndex) => {
  const message = file.message(
    'Avoid raw "<" in documentation prose; use "&lt;" or rewrite the sentence.',
    node,
  );
  message.ruleId = RULE_ID;
  message.source = 'remark-lint';
  message.fatal = true;

  const position = createPositionForMatch(node, matchIndex);
  if (position) {
    message.position = position;
  }
};

const lintAngleBrackets = (file, node) => {
  const value = node.value;
  if (value?.includes('<')) {
    for (const match of value.matchAll(/</g)) {
      reportAngleBracket(file, node, match.index ?? 0);
    }
  }
};

/**
 * remark-lint rule: disallow raw `<` characters in prose to avoid MDX parse errors.
 */
export default function remarkLintNoAngleBrackets() {
  return (tree, file) => {
    visit(tree, 'text', (node) => {
      lintAngleBrackets(file, node);
    });
  };
}

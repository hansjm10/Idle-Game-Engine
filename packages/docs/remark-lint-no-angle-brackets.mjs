import {visit} from 'unist-util-visit';

const RULE_ID = 'no-unescaped-angle-brackets';

/**
 * remark-lint rule: disallow raw `<` characters in prose to avoid MDX parse errors.
 */
export default function remarkLintNoAngleBrackets() {
  return (tree, file) => {
    visit(tree, 'text', (node) => {
      const value = node.value;
      if (!value || !value.includes('<')) {
        return;
      }

      for (const match of value.matchAll(/</g)) {
        const message = file.message(
          'Avoid raw "<" in documentation prose; use "&lt;" or rewrite the sentence.',
          node,
        );
        message.ruleId = RULE_ID;
        message.source = 'remark-lint';
        message.fatal = true;

        const startPosition = node.position?.start;
        if (startPosition && match.index != null) {
          const startOffset = startPosition.offset;
          const start = {
            line: startPosition.line,
            column: startPosition.column + match.index,
            offset:
              startOffset != null
                ? startOffset + match.index
                : undefined,
          };
          const end = {
            line: start.line,
            column: start.column + 1,
            offset: start.offset != null ? start.offset + 1 : undefined,
          };
          message.position = {start, end};
        }
      }
    });
  };
}

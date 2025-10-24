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

        if (node.position && match.index != null) {
          const start = {
            line: node.position.start.line,
            column: node.position.start.column + match.index,
            offset:
              node.position.start.offset != null
                ? node.position.start.offset + match.index
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

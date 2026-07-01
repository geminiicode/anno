const MD_EXTENSIONS = ['md', 'markdown', 'mdown', 'mkd'];
const MD_RE = new RegExp(`\\.(${MD_EXTENSIONS.join('|')})$`, 'i');

module.exports = { MD_EXTENSIONS, MD_RE };

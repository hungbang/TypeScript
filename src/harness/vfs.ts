// tslint:disable:no-null-keyword
namespace vfs {
    const _throw = (e: any) => { throw e; };

    // file type
    const S_IFMT            = 0o170000; // file type
    const S_IFSOCK          = 0o140000; // socket
    const S_IFLNK           = 0o120000; // symbolic link
    const S_IFREG           = 0o100000; // regular file
    const S_IFBLK           = 0o060000; // block device
    const S_IFDIR           = 0o040000; // directory
    const S_IFCHR           = 0o020000; // character device
    const S_IFIFO           = 0o010000; // FIFO

    const O_ACCMODE         = 0o00000003;
    const O_RDONLY          = 0o00000000;
    const O_WRONLY          = 0o00000001;
    const O_RDWR            = 0o00000002;

    const O_CREAT           = 0o00000100;
    const O_EXCL            = 0o00000200;
    const O_TRUNC           = 0o00001000;
    const O_APPEND          = 0o00002000;
    const O_SYNC            = 0o00010000; // explicit fsync
    const O_DIRECTORY       = 0o00200000;
    const O_NOFOLLOW        = 0o00400000;

    const F_OK              = 0o00000000; // path is visible to the current process
    const W_OK              = 0o00000002; // path can be written to by the current process
    const R_OK              = 0o00000004; // path can be read by the current process

    let devCount = 0; // A monotonically increasing count of device ids
    let inoCount = 0; // A monotonically increasing count of inodes
    let fdCount = 0; // A monotonically increasing count of file descriptors

    /**
     * Represents a virtual POSIX-like file system.
     */
    export class FileSystem {
        /** Indicates whether the file system is case-sensitive (`false`) or case-insensitive (`true`). */
        public readonly ignoreCase: boolean;

        /** Gets the comparison function used to compare two paths. */
        public readonly stringComparer: (a: string, b: string) => number;

        // lazy-initialized state that should be mutable even if the FileSystem is frozen.
        private _lazy: {
            links?: core.SortedMap<string, Inode>;
            shadows?: Map<number, Inode>;
            meta?: core.Metadata;
        } = {};

        private _cwd: string; // current working directory
        private _time: number | Date | (() => number | Date);
        private _openFiles = new Map<number, OpenFileDescription>();
        private _shadowRoot: FileSystem | undefined;
        private _dirStack: string[] | undefined;

        constructor(ignoreCase: boolean, options: FileSystemOptions = {}) {
            const { time = -1, files, meta } = options;
            this.ignoreCase = ignoreCase;
            this.stringComparer = this.ignoreCase ? vpath.compareCaseInsensitive : vpath.compareCaseSensitive;
            this._time = time;

            if (meta) {
                for (const key of Object.keys(meta)) {
                    this.meta.set(key, meta[key]);
                }
            }

            if (files) {
                this._applyFiles(files, /*dirname*/ "");
            }

            let cwd = options.cwd;
            if ((!cwd || !vpath.isRoot(cwd)) && this._lazy.links) {
                const iterator = core.getIterator(this._lazy.links.keys());
                try {
                    for (let i = core.nextResult(iterator); i; i = core.nextResult(iterator)) {
                        const name = i.value;
                        cwd = cwd ? vpath.resolve(name, cwd) : name;
                        break;
                    }
                }
                finally {
                    core.closeIterator(iterator);
                }
            }

            if (cwd) {
                vpath.validate(cwd, vpath.ValidationFlags.Absolute);
                this.mkdirpSync(cwd, /*mode*/ 0o777);
            }

            this._cwd = cwd || "";
        }

        /**
         * Gets metadata for this `FileSystem`.
         */
        public get meta(): core.Metadata {
            if (!this._lazy.meta) {
                this._lazy.meta = new core.Metadata(this._shadowRoot ? this._shadowRoot.meta : undefined);
            }
            return this._lazy.meta;
        }

        /**
         * Gets a value indicating whether the file system is read-only.
         */
        public get isReadonly() {
            return Object.isFrozen(this);
        }

        /**
         * Makes the file system read-only.
         */
        public makeReadonly() {
            Object.freeze(this);
            return this;
        }

        /**
         * Gets the file system shadowed by this file system.
         */
        public get shadowRoot() {
            return this._shadowRoot;
        }

        /**
         * Gets a shadow of this file system.
         */
        public shadow(ignoreCase = this.ignoreCase) {
            if (!this.isReadonly) throw new Error("Cannot shadow a mutable file system.");
            if (ignoreCase && !this.ignoreCase) throw new Error("Cannot create a case-insensitive file system from a case-sensitive one.");
            const fs = new FileSystem(ignoreCase, { time: this._time });
            fs._shadowRoot = this;
            fs._cwd = this._cwd;
            return fs;
        }

        /**
         * Gets the metadata object for a path.
         * @param path
         */
        public filemeta(path: string): core.Metadata {
            path = this._resolve(path);
            const { node } = this._find(path) || _throw(new IOError("ENOENT", "scandir", path));
            return this._filemeta(node);
        }

        private _filemeta(node: Inode): core.Metadata {
            if (!node.meta) {
                const parentMeta = node.shadowRoot && this._shadowRoot && this._shadowRoot._filemeta(node.shadowRoot);
                node.meta = new core.Metadata(parentMeta);
            }
            return node.meta;
        }

        /**
         * Gets or sets the timestamp (in milliseconds) used for file status, returning the previous timestamp.
         *
         * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/time.html
         */
        public time(value?: number | Date | (() => number | Date)): number {
            if (value !== undefined && this.isReadonly) throw new IOError("EPERM");
            let result = this._time;
            if (typeof result === "function") result = result();
            if (typeof result === "object") result = result.getTime();
            if (result === -1) result = Date.now();
            if (value !== undefined) {
                this._time = value;
            }
            return result;
        }

        /**
         * Get the pathname of the current working directory.
         *
         * @link - http://pubs.opengroup.org/onlinepubs/9699919799/functions/getcwd.html
         */
        public cwd() {
            if (!this._cwd) throw new Error("The current working directory has not been set.");
            const { node } = this._find(this._cwd) || _throw(new IOError("ENOENT", "getcwd"));
            if (!isDirectoryInode(node)) throw new IOError("ENOTDIR", "getcwd");
            return this._cwd;
        }

        /**
         * Changes the current working directory.
         *
         * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/chdir.html
         */
        public chdir(path: string) {
            if (this.isReadonly) throw new IOError("EPERM", "chdir", path);
            path = this._resolve(path);
            const { node } = this._find(path) || _throw(new IOError("ENOENT", "chdir", path));
            if (!isDirectoryInode(node)) throw new IOError("ENOTDIR", "chdir", path);
            if (this._cwd !== path) {
                this._cwd = path;
            }
        }

        /**
         * Pushes the current directory onto the directory stack and changes the current working directory to the supplied path.
         */
        public pushd(path?: string) {
            if (this.isReadonly) throw new IOError("EPERM", "chdir", path);
            if (path) path = this._resolve(path);
            if (this._cwd) {
                if (!this._dirStack) this._dirStack = [];
                this._dirStack.push(this._cwd);
            }
            if (path && path !== this._cwd) {
                this.chdir(path);
            }
        }

        /**
         * Pops the previous directory from the location stack and changes the current directory to that directory.
         */
        public popd() {
            if (this.isReadonly) throw new IOError("EPERM", "popd");
            const path = this._dirStack && this._dirStack.pop();
            if (path) {
                this.chdir(path);
            }
        }

        /**
         * Apply a file map to the file system.
         */
        public apply(files: FileSet) {
            this._applyFiles(files, this._cwd);
        }

        /**
         * Recursively remove all files and directories underneath the provided path.
         */
        public rimrafSync(path: string) {
            try {
                const stats = this.lstatSync(path);
                if (stats.isFile() || stats.isSymbolicLink()) {
                    this.unlinkSync(path);
                }
                else if (stats.isDirectory()) {
                    for (const file of this.readdirSync(path)) {
                        this.rimrafSync(vpath.combine(path, file));
                    }
                    this.rmdirSync(path);
                }
            }
            catch (e) {
                if (e.code === "ENOENT") return;
                throw e;
            }
        }

        /**
         * Changes the permissions of a file. If `path` is a symbolic link, it is dereferenced.
         *
         * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/chmod.html
         *
         * NOTE: do not rename this method as it is intended to align with the same named export of the "fs" module.
         */
        public chmodSync(path: string, mode: number) {
            path = this._resolve(path);

            const entry = this._find(path) || _throw(new IOError("ENOENT", "chmod", path));
            if (!isFinite(mode)) throw new IOError("EINVAL", "chmod", path);
            if (this.isReadonly) throw new IOError("EROFS", "chmod", path);

            entry.node.mode = (entry.node.mode & S_IFMT) | (mode & 0o7777);
            entry.node.ctimeMs = this.time();
        }

        /**
         * Get file status. If `path` is a symbolic link, it is dereferenced.
         *
         * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/stat.html
         *
         * NOTE: do not rename this method as it is intended to align with the same named export of the "fs" module.
         */
        public statSync(path: string) {
            path = this._resolve(path);
            return this._stat("stat", this._find(path) || _throw(new IOError("ENOENT", "stat", path)), path);
        }

        /**
         * Get file status.
         *
         * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/lstat.html
         *
         * NOTE: do not rename this method as it is intended to align with the same named export of the "fs" module.
         */
        public lstatSync(path: string) {
            path = this._resolve(path);
            return this._stat("lstat", this._lfind(path) || _throw(new IOError("ENOENT", "lstat", path)), path);
        }

        /**
         * Get file status.
         *
         * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/fstat.html
         *
         * NOTE: do not rename this method as it is intended to align with the same named export of the "fs" module.
         */
        public fstatSync(fd: number) {
            return this._stat("fstat", this._file("fstat", fd));
        }

        private _stat(_syscall: string, entry: FileDescription, _path?: string) {
            const node = entry.node;
            return new Stats(
                node.dev,
                node.ino,
                node.mode,
                node.nlink,
                /*rdev*/ 0,
                /*size*/ isFileInode(node) ? this._getSize(node) : isSymlinkInode(node) ? node.symlink.length : 0,
                /*blksize*/ 4096,
                /*blocks*/ 0,
                node.atimeMs,
                node.mtimeMs,
                node.ctimeMs,
                node.birthtimeMs,
            );
        }

        /**
         * Scan file system entries along a path. If `path` is a symbolic link, it is dereferenced.
         * @param path The path at which to start the scan.
         * @param axis The axis along which to traverse.
         * @param traversal The traversal scheme to use.
         */
        public scanSync(path: string, axis: Axis, traversal: Traversal) {
            path = this._resolve(path);
            const results: string[] = [];
            this._scan(path, this.statSync(path), axis, traversal, /*noFollow*/ false, results);
            return results;
        }

        /**
         * Scan file system entries along a path.
         * @param path The path at which to start the scan.
         * @param axis The axis along which to traverse.
         * @param traversal The traversal scheme to use.
         */
        public lscanSync(path: string, axis: Axis, traversal: Traversal) {
            path = this._resolve(path);
            const results: string[] = [];
            this._scan(path, this.statSync(path), axis, traversal, /*noFollow*/ true, results);
            return results;
        }

        private _scan(path: string, stats: Stats, axis: Axis, traversal: Traversal, noFollow: boolean, results: string[]) {
            if (axis === "ancestors-or-self" || axis === "self" || axis === "descendants-or-self") {
                if (!traversal.accept || traversal.accept(path, stats)) {
                    results.push(path);
                }
            }
            if (axis === "ancestors-or-self" || axis === "ancestors") {
                const dirname = vpath.dirname(path);
                if (dirname !== path) {
                    try {
                        const stats = this._stat("scandir", this._walk(dirname, noFollow) || _throw(new IOError("ENOENT", "scandir", dirname)));
                        if (!traversal.traverse || traversal.traverse(dirname, stats)) {
                            this._scan(dirname, stats, "ancestors-or-self", traversal, noFollow, results);
                        }
                    }
                    catch { /*ignored*/ }
                }
            }
            if (axis === "descendants-or-self" || axis === "descendants") {
                if (stats.isDirectory() && (!traversal.traverse || traversal.traverse(path, stats))) {
                    for (const file of this.readdirSync(path)) {
                        try {
                            const childpath = vpath.combine(path, file);
                            const stats = this._stat("scandir", this._walk(childpath, noFollow) || _throw(new IOError("ENOENT", "scandir", childpath)));
                            this._scan(childpath, stats, "descendants-or-self", traversal, noFollow, results);
                        }
                        catch { /*ignored*/ }
                    }
                }
            }
        }

        /**
         * Read a directory. If `path` is a symbolic link, it is dereferenced.
         *
         * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/readdir.html
         *
         * NOTE: do not rename this method as it is intended to align with the same named export of the "fs" module.
         */
        public readdirSync(path: string) {
            path = this._resolve(path);
            const { node } = this._find(path) || _throw(new IOError("ENOENT", "readdir", path));
            if (!isDirectoryInode(node)) throw new IOError("ENOTDIR", "readdir", path);
            return Array.from(this._getLinks(node).keys());
        }

        /**
         * Mounts a physical or virtual file system at a location in this virtual file system.
         *
         * @param source The path in the physical (or other virtual) file system.
         * @param target The path in this virtual file system.
         * @param resolver An object used to resolve files in `source`.
         */
        public mountSync(source: string, target: string, resolver: FileSystemResolver, mode = 0o777) {
            source = vpath.validate(source, vpath.ValidationFlags.Absolute);
            target = this._resolve(target);
            mode = mode & 0o1777; // allows S_ISVTX bit

            let parent: DirectoryInode | undefined;
            let name: string;

            // special case for FS root
            if (this.stringComparer(vpath.dirname(target), target) === 0) {
                name = target;
            }
            else {
                const entry = this._find(vpath.dirname(target)) || _throw(new IOError("ENOENT", "mount", source, target));
                if (!isDirectoryInode(entry.node)) throw new IOError("ENOTDIR", "mount", source, target);
                parent = entry.node;
                name = vpath.basename(target);
            }

            const links = this._getLinks(parent);
            if (links.has(name)) throw new IOError("EEXIST", "mount", source, target);
            if (this.isReadonly) throw new IOError("EROFS", "mount", source, target);

            const node = parent
                ? this._mknod(parent.dev, S_IFDIR, mode)
                : this._mknod(++devCount, S_IFDIR, mode, /*umask*/ 0o000);

            node.source = source;
            node.resolver = resolver;

            this._addLink(parent, links, name, node);

            if (parent) {
                parent.mtimeMs = this.time();
            }
            else if (!this._cwd) {
                this._cwd = name;
            }
        }

        /**
         * Make a directory.
         *
         * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/mkdir.html
         *
         * NOTE: do not rename this method as it is intended to align with the same named export of the "fs" module.
         */
        public mkdirSync(path: string, mode = 0o777) {
            path = this._resolve(path);
            if (!isFinite(mode)) throw new IOError("EINVAL", "mkdir", path);
            mode = mode & 0o1777; // allows S_ISVTX bit

            let parent: DirectoryInode | undefined;
            let name: string;

            // special case for FS root
            if (this.stringComparer(vpath.dirname(path), path) === 0) {
                name = path;
            }
            else {
                const parentEntry = this._find(vpath.dirname(path)) || _throw(new IOError("ENOENT", "mkdir", path));
                if (!isDirectoryInode(parentEntry.node)) throw new IOError("ENOTDIR", "mkdir", path);
                parent = parentEntry.node;
                name = vpath.basename(path);
            }

            const links = this._getLinks(parent);
            if (links.has(name)) throw new IOError("EEXIST", "mkdir", path);
            if (this.isReadonly) throw new IOError("EROFS", "mkdir", path);

            const node = parent
                ? this._mknod(parent.dev, S_IFDIR, mode)
                : this._mknod(++devCount, S_IFDIR, mode, /*umask*/ 0o000);

            this._addLink(parent, links, name, node);

            if (parent) {
                parent.mtimeMs = this.time();
            }
            else if (!this._cwd) {
                this._cwd = name;
            }
        }

        /**
         * Make a directory and all of its parent paths (if they don't exist).
         */
        public mkdirpSync(path: string, mode = 0o777) {
            path = this._resolve(path);
            try {
                this.mkdirSync(path, mode);
            }
            catch (e) {
                if (e.code === "ENOENT") {
                    this.mkdirpSync(vpath.dirname(path), mode);
                    this.mkdirSync(path, mode);
                }
                else if (e.code !== "EEXIST") {
                    throw e;
                }
            }
        }

        /**
         * Remove a directory.
         *
         * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/rmdir.html
         *
         * NOTE: do not rename this method as it is intended to align with the same named export of the "fs" module.
         */
        public rmdirSync(path: string) {
            path = this._resolve(path);

            const { parent, node } = this._find(path) || _throw(new IOError("ENOENT", "rmdir", path));
            if (!isDirectoryInode(node)) throw new IOError("ENOTDIR", "rmdir", path);
            if (this._getLinks(node).size !== 0) throw new IOError("ENOTEMPTY", "rmdir", path);
            if (this.isReadonly) throw new IOError("EROFS", "rmdir", path);

            const name = vpath.basename(path);
            const links = this._getLinks(parent);
            this._removeLink(parent, links, name, node);

            const time = this.time();
            parent.mtimeMs = time;
            node.ctimeMs = time;
            this._invalidatePaths(node);
        }

        /**
         * Link one file to another file (also known as a "hard link").
         *
         * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/link.html
         *
         * NOTE: do not rename this method as it is intended to align with the same named export of the "fs" module.
         */
        public linkSync(oldpath: string, newpath: string) {
            oldpath = this._resolve(oldpath);
            newpath = this._resolve(newpath);

            const { node } = this._find(oldpath) || _throw(new IOError("ENOENT", "link", oldpath, newpath));
            if (isDirectoryInode(node)) throw new IOError("EPERM", "link", oldpath, newpath);

            const { node: newParent } = this._find(vpath.dirname(newpath)) || _throw(new IOError("ENOENT", "link", oldpath, newpath));
            if (!isDirectoryInode(newParent)) throw new IOError("ENOTDIR", "link", oldpath, newpath);

            const newParentLinks = this._getLinks(newParent);
            const newBasename = vpath.basename(newpath);

            if (newParentLinks.has(newBasename)) throw new IOError("EEXIST", "link", oldpath, newpath);
            if (this.isReadonly) throw new IOError("EROFS", "link", oldpath, newpath);

            this._addLink(newParent, newParentLinks, newBasename, node);

            const time = this.time();
            newParent.mtimeMs = time;
            node.ctimeMs = time;
            this._invalidatePaths(node);
        }

        /**
         * Remove a directory entry.
         *
         * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/unlink.html
         *
         * NOTE: do not rename this method as it is intended to align with the same named export of the "fs" module.
         */
        public unlinkSync(path: string) {
            path = this._resolve(path);

            const { parent, node, basename } = this._lfind(path) || _throw(new IOError("ENOENT", "unlink", path));
            if (isDirectoryInode(node)) throw new IOError("EISDIR", "unlink", path);
            if (this.isReadonly) throw new IOError("EROFS", "unlink", path);

            const links = this._getLinks(parent);
            this._removeLink(parent, links, basename, node);

            const time = this.time();
            parent.mtimeMs = time;
            node.ctimeMs = time;
            this._invalidatePaths(node);
        }

        /**
         * Rename a file.
         *
         * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/rename.html
         *
         * NOTE: do not rename this method as it is intended to align with the same named export of the "fs" module.
         */
        public renameSync(oldpath: string, newpath: string) {
            oldpath = this._resolve(oldpath);
            newpath = this._resolve(newpath);

            const { parent: oldParent, node, basename: oldBasename } = this._lfind(oldpath) || _throw(new IOError("ENOENT", "rename", oldpath, newpath));
            const { node: newParent } = this._find(vpath.dirname(newpath)) || _throw(new IOError("ENOENT", "rename", oldpath, newpath));
            if (!isDirectoryInode(newParent)) throw new IOError("ENOTDIR", "rename", oldpath, newpath);

            const newBasename = vpath.basename(newpath);
            const newParentLinks = this._getLinks(newParent);
            const existingNode = newParentLinks.get(newBasename);
            if (existingNode) {
                if (isDirectoryInode(node)) {
                    if (!isDirectoryInode(existingNode)) throw new IOError("ENOTDIR", "rename", oldpath, newpath);
                    if (this._getLinks(existingNode).size > 0) throw new IOError("ENOTEMPTY", "rename", oldpath, newpath);
                }
                else {
                    if (isDirectoryInode(existingNode)) throw new IOError("EISDIR", "rename", oldpath, newpath);
                }
            }

            if (this.isReadonly) throw new IOError("EROFS", "rename", oldpath, newpath);

            const time = this.time();
            if (existingNode) {
                this._removeLink(newParent, newParentLinks, newBasename, existingNode);
                this._invalidatePaths(existingNode);
                existingNode.ctimeMs = time;
            }

            const oldParentLinks = this._getLinks(oldParent);
            this._replaceLink(oldParent, oldParentLinks, oldBasename, newParent, newParentLinks, newBasename, node);

            oldParent.mtimeMs = time;
            newParent.mtimeMs = time;
            this._invalidatePaths(node);
        }

        /**
         * Make a symbolic link.
         *
         * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/symlink.html
         *
         * NOTE: do not rename this method as it is intended to align with the same named export of the "fs" module.
         */
        public symlinkSync(target: string, linkpath: string) {
            target = vpath.validate(target, vpath.ValidationFlags.RelativeOrAbsolute);
            linkpath = this._resolve(linkpath);

            const dirname = vpath.dirname(linkpath);
            const { node: parent } = this._find(dirname) || _throw(new IOError("ENOENT", "symlink", target, linkpath));
            if (!isDirectoryInode(parent)) throw new IOError("ENOTDIR", "symlink", target, linkpath);

            const basename = vpath.basename(linkpath);
            const parentLinks = this._getLinks(parent);

            if (parentLinks.has(basename)) throw new IOError("EEXIST", "symlink", target, linkpath);
            if (this.isReadonly) throw new IOError("EROFS", "symlink", target, linkpath);

            const node = this._mknod(parent.dev, S_IFLNK, 0o666);
            node.symlink = target;

            this._addLink(parent, parentLinks, basename, node);

            const time = this.time();
            parent.mtimeMs = time;
        }

        /**
         * Read the contents of a symbolic link.
         *
         * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/readlink.html
         *
         * NOTE: do not rename this method as it is intended to align with the same named export of the "fs" module.
         */
        public readlinkSync(path: string) {
            path = this._resolve(path);

            const { node } = this._lfind(path) || _throw(new IOError("ENOENT", "readlink", path));
            if (!isSymlinkInode(node)) throw new IOError("EINVAL", "readlink", path);

            return node.symlink;
        }

        /**
         * Resolve a pathname.
         *
         * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/realpath.html
         *
         * NOTE: do not rename this method as it is intended to align with the same named export of the "fs" module.
         */
        public realpathSync(path: string) {
            path = this._resolve(path);
            const entry = this._find(path) || _throw(new IOError("ENOENT", "realpath", path));
            return entry.path;
        }

        /**
         * Open a file.
         *
         * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/open.html
         *
         * NOTE: do not rename this method as it is intended to align with the same named export of the "fs" module.
         */
        public openSync(path: string, flags: string | number, mode = 0o666): number {
            path = this._resolve(path);
            flags = parseFlags(flags);
            if (!isFinite(flags) || !isFinite(mode)) throw new IOError("EINVAL", "open", path);

            const write = flags & O_ACCMODE && flags & O_CREAT | O_TRUNC;
            if (write && this.isReadonly) throw new IOError("EROFS", "open", path);

            const basename = vpath.basename(path);
            const entry = this._walk(path, /*noFollow*/ !!(flags & O_NOFOLLOW));

            let node: Inode;
            let parent: Inode;
            if (!entry) {
                if (~flags & O_CREAT) throw new IOError("ENOENT", "open", path);
                if (flags & O_DIRECTORY) throw new IOError("ENOTDIR", "open", path);
                flags |= O_TRUNC;

                const entry = this._walk(vpath.dirname(path), /*noFollow*/ false) || _throw(new IOError("ENOENT", "open", path));
                parent = entry.node;

                if (!isDirectoryInode(parent)) throw new IOError("ENOTDIR", "open", path);

                node = this._mknod(parent.dev, S_IFREG, mode);
                node.buffer = Buffer.allocUnsafe(0);
                const links = this._getLinks(parent);
                this._addLink(parent, links, basename, node);

                const time = this.time();
                parent.mtimeMs = time;
            }
            else {
                if (flags & O_EXCL) throw new IOError("EEXIST", "open", path);
                node = entry.node;
                parent = entry.parent;
            }

            if (flags & O_DIRECTORY && isFileInode(node)) throw new IOError("ENOTDIR", "open", path);
            if (write && isDirectoryInode(node)) throw new IOError("EISDIR", "open", path);

            const file: OpenFileDescription = {
                fd: ++fdCount,
                path,
                basename,
                parent,
                node,
                flags,
                written: false,
                offset: isFileInode(node) && (flags & (O_APPEND | O_TRUNC)) === O_APPEND ? this._getSize(node) : 0,
                buffer: undefined
            };

            this._openFiles.set(file.fd, file);

            if (flags & O_TRUNC) {
                file.buffer = Buffer.allocUnsafe(0);
                if (flags & O_SYNC) {
                    this._fsync(file, /*metadata*/ true);
                }
            }

            return file.fd;
        }

        /**
         * Close a file descriptor.
         *
         * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/close.html#
         *
         * NOTE: do not rename this method as it is intended to align with the same named export of the "fs" module.
         */
        public closeSync(fd: number) {
            const entry = this._file("close", fd);
            this._openFiles.delete(entry.fd);
            this._fsync(entry, /*metadata*/ true);
        }

        /**
         * Read from a file.
         *
         * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/read.html
         *
         * NOTE: do not rename this method as it is intended to align with the same named export of the "fs" module.
         */
        public readSync(fd: number, buffer: Buffer, offset: number, length: number, position?: number | null) {
            if (typeof position !== "number") position = -1;
            if (!isFinite(offset) || !isFinite(length) || !isFinite(position)) throw new IOError("EINVAL", "read");
            if (offset < 0 || length < 0 || position < -1 || offset > buffer.byteLength - length) throw new IOError("EINVAL", "read");
            if (length === 0) return 0;

            const entry = this._file("read", fd, "file", R_OK);
            const node = entry.node;
            if (position !== -1) entry.offset = position;
            if (!entry.buffer) entry.buffer = this._getBuffer(node);
            const bytesRead = entry.buffer.copy(buffer, offset, entry.offset, entry.offset + length);
            entry.offset += bytesRead;
            return bytesRead;
        }

        /**
         * Read from a file.
         *
         * NOTE: do not rename this method as it is intended to align with the same named export of the "fs" module.
         */
        public readFileSync(path: string | number, options?: { encoding?: null, flag?: string | number } | null): Buffer;
        /**
         * Read from a file.
         *
         * NOTE: do not rename this method as it is intended to align with the same named export of the "fs" module.
         */
        public readFileSync(path: string | number, options: { encoding: string, flag?: string | number } | string): string;
        /**
         * Read from a file.
         *
         * NOTE: do not rename this method as it is intended to align with the same named export of the "fs" module.
         */
        public readFileSync(path: string | number, options?: { encoding?: string | null, flag?: string | number } | string | null): string | Buffer;
        public readFileSync(path: string | number, options: { encoding?: string | null, flag?: string | number } | string | null = {}) {
            if (options === null || typeof options === "string") options = { encoding: options as string };
            const { encoding, flag = "r" } = options;
            const fd = typeof path === "number" ? path : this.openSync(path, flag, /*mode*/ 0o666);
            const size = this.fstatSync(fd).size;
            let buffer = Buffer.allocUnsafe(size);
            try {
                let offset = 0;
                let lastOffset: number | undefined;
                while (lastOffset !== offset && offset < size) {
                    lastOffset = offset;
                    offset += this.readSync(fd, buffer, offset, size - offset, offset);
                }
                if (offset < size) buffer = buffer.slice(0, offset);
            }
            finally {
                if (typeof path !== "number") {
                    this.closeSync(fd);
                }
            }
            return encoding ? buffer.toString(encoding) : buffer;
        }

        /**
         * Write to a file.
         *
         * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/write.html
         *
         * NOTE: do not rename this method as it is intended to align with the same named export of the "fs" module.
         */
        public writeSync(fd: number, buffer: Buffer, offset?: number, length?: number, position?: number | null): number;
        /**
         * Write to a file.
         *
         * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/write.html
         *
         * NOTE: do not rename this method as it is intended to align with the same named export of the "fs" module.
         */
        public writeSync(fd: number, text: string, position?: number | null, encoding?: string): number;
        public writeSync(fd: number, buffer: Buffer | string, offset?: number | null, length?: number | string, position?: number | null) {
            if (Buffer.isBuffer(buffer)) {
                if (typeof offset !== "number") offset = 0;
                if (typeof length !== "number") length = buffer.byteLength - offset;
            }
            else {
                buffer = Buffer.from(buffer, typeof length === "string" ? length : "utf8");
                position = offset;
                offset = 0;
                length = buffer.byteLength;
            }

            if (typeof position !== "number") position = -1;
            if (!isFinite(offset) || !isFinite(length) || !isFinite(position)) throw new IOError("EINVAL", "write");
            if (offset < 0 || length < 0 || position < -1 || offset > buffer.byteLength - length) throw new IOError("EINVAL", "write");
            if (length === 0) return;

            const entry = this._file("write", fd, "file", W_OK);
            const node = entry.node;
            if (position !== -1) entry.offset = position;
            if (!entry.buffer) {
                // if we haven't yet started writing, get a copy of the storage buffer
                const buffer = this._getBuffer(node);
                entry.buffer = Buffer.allocUnsafe(buffer.byteLength);
                buffer.copy(entry.buffer, 0, 0, buffer.byteLength);
            }
            if (entry.offset >= entry.buffer.byteLength - length) {
                // if we are writing to a point outside of the size of the buffer, resize it
                entry.buffer = resizeBuffer(entry.buffer, entry.offset + length);
            }
            const bytesWritten = buffer.copy(entry.buffer, entry.offset, offset, offset + length);
            entry.offset += bytesWritten;
            if (entry.flags & O_SYNC) {
                this._fsync(entry, /*metadata*/ true);
            }
            return bytesWritten;
        }

        /**
         * Write to a file.
         *
         * NOTE: do not rename this method as it is intended to align with the same named export of the "fs" module.
         */
        public writeFileSync(path: string | number, data: string | Buffer, options: { encoding?: string | null, mode?: number, flag?: string | number } | string | null = {}) {
            if (options === null) options = { encoding: null };
            else if (typeof options === "string") options = { encoding: options };
            const { encoding, mode = 0o666, flag = "w" } = options;
            const flags = parseFlags(flag);
            const fd = typeof path === "number" ? path : this.openSync(path, flags, mode);
            const buffer = Buffer.isBuffer(data) ? data : Buffer.from("" + data, encoding || "utf8");
            try {
                let offset = 0;
                while (offset < buffer.byteLength) {
                    offset += this.writeSync(fd, buffer, offset, buffer.byteLength - offset, flags & O_APPEND ? null : offset);
                }
            }
            finally {
                if (typeof path !== "number") {
                    this.closeSync(fd);
                }
            }
        }

        /**
         * Print diagnostic information about the structure of the file system to the console.
         */
        public debugPrint(): void {
            let result = "";
            const printLinks = (dirname: string | undefined, links: core.SortedMap<string, Inode>) => {
                const iterator = core.getIterator(links);
                try {
                    for (let i = core.nextResult(iterator); i; i = core.nextResult(iterator)) {
                        const [name, node] = i.value;
                        const path = dirname ? vpath.combine(dirname, name) : name;
                        const marker = vpath.compare(this._cwd, path, this.ignoreCase) === 0 ? "*" : " ";
                        if (result) result += "\n";
                        result += marker;
                        if (isDirectoryInode(node)) {
                            result += vpath.addTrailingSeparator(path);
                            printLinks(path, this._getLinks(node));
                        }
                        else if (isFileInode(node)) {
                            result += path;
                        }
                        else if (isSymlinkInode(node)) {
                            result += path + " -> " + node.symlink;
                        }
                    }
                }
                finally {
                    core.closeIterator(iterator);
                }
            };
            printLinks(/*dirname*/ undefined, this._getRootLinks());
            console.log(result);
        }

        private _mknod(dev: number, type: typeof S_IFREG, mode: number, umask?: number): FileInode;
        private _mknod(dev: number, type: typeof S_IFDIR, mode: number, umask?: number): DirectoryInode;
        private _mknod(dev: number, type: typeof S_IFLNK, mode: number, umask?: number): SymlinkInode;
        private _mknod(dev: number, type: number, mode: number, umask = 0o022) {
            const timestamp = this.time();
            return <Inode>{
                dev,
                ino: ++inoCount,
                mode: (mode & ~S_IFMT & ~umask & 0o7777) | (type & S_IFMT),
                atimeMs: timestamp,
                mtimeMs: timestamp,
                ctimeMs: timestamp,
                birthtimeMs: timestamp,
                nlink: 0,
                incomingLinks: new Map<DirectoryInode, core.SortedSet<string>>(),
            };
        }

        private _fsync(entry: OpenFileDescription, metadata: boolean) {
            if (isFileInode(entry.node) && entry.buffer && entry.buffer !== entry.node.buffer) {
                const time = this.time();
                entry.node.buffer = entry.buffer;
                entry.node.mtimeMs = time;
                entry.node.ctimeMs = time;
                if (metadata) {
                    entry.node.size = entry.node.buffer.byteLength;
                }
            }
        }

        private _addLink(parent: DirectoryInode | undefined, links: core.SortedMap<string, Inode>, name: string, node: Inode) {
            links.set(name, node);
            node.nlink++;

            let set = node.incomingLinks.get(parent);
            if (!set) node.incomingLinks.set(parent, set = new core.SortedSet(this.stringComparer));
            set.add(name);
        }

        private _removeLink(parent: DirectoryInode | undefined, links: core.SortedMap<string, Inode>, name: string, node: Inode) {
            links.delete(name);
            node.nlink--;

            const set = node.incomingLinks.get(parent);
            if (set) {
                set.delete(name);
                if (set.size === 0) node.incomingLinks.delete(parent);
            }
        }

        private _replaceLink(oldParent: DirectoryInode, oldLinks: core.SortedMap<string, Inode>, oldName: string, newParent: DirectoryInode, newLinks: core.SortedMap<string, Inode>, newName: string, node: Inode) {
            if (oldParent !== newParent) {
                this._removeLink(oldParent, oldLinks, oldName, node);
                this._addLink(newParent, newLinks, newName, node);
                return;
            }

            oldLinks.delete(oldName);
            oldLinks.set(newName, node);

            const set = node.incomingLinks.get(oldParent);
            if (set) {
                set.delete(oldName);
                set.add(newName);
            }
        }

        private _getRootLinks() {
            if (!this._lazy.links) {
                this._lazy.links = new core.SortedMap<string, Inode>(this.stringComparer);
                if (this._shadowRoot) {
                    this._copyShadowLinks(this._shadowRoot._getRootLinks(), this._lazy.links);
                }
                this._lazy.links = this._lazy.links;
            }
            return this._lazy.links;
        }

        private _getLinks(node: DirectoryInode | undefined) {
            if (!node) return this._getRootLinks();
            if (!node.links) {
                const links = new core.SortedMap<string, Inode>(this.stringComparer);
                const { source, resolver } = node;
                if (source && resolver) {
                    node.source = undefined;
                    node.resolver = undefined;
                    for (const name of resolver.readdirSync(source)) {
                        const path = vpath.combine(source, name);
                        const stats = resolver.statSync(path);
                        switch (stats.mode & S_IFMT) {
                            case S_IFDIR:
                                const dir = this._mknod(node.dev, S_IFDIR, 0o777);
                                dir.source = vpath.combine(source, name);
                                dir.resolver = resolver;
                                this._addLink(node, links, name, dir);
                                break;
                            case S_IFREG:
                                const file = this._mknod(node.dev, S_IFREG, 0o666);
                                file.source = vpath.combine(source, name);
                                file.resolver = resolver;
                                file.size = stats.size;
                                this._addLink(node, links, name, file);
                                break;
                        }
                    }
                }
                else if (this._shadowRoot && node.shadowRoot) {
                    this._copyShadowLinks(this._shadowRoot._getLinks(node.shadowRoot), links);
                }
                node.links = links;
            }
            return node.links;
        }

        private _getShadow(root: DirectoryInode): DirectoryInode;
        private _getShadow(root: Inode): Inode;
        private _getShadow(root: Inode) {
            const shadows = this._lazy.shadows || (this._lazy.shadows = new Map<number, Inode>());

            let shadow = shadows.get(root.ino);
            if (!shadow) {
                shadow = <Inode>{
                    dev: root.dev,
                    ino: root.ino,
                    mode: root.mode,
                    atimeMs: root.atimeMs,
                    mtimeMs: root.mtimeMs,
                    ctimeMs: root.ctimeMs,
                    birthtimeMs: root.birthtimeMs,
                    nlink: root.nlink,
                    shadowRoot: root,
                    incomingLinks: new Map<DirectoryInode, core.SortedSet<string>>(),
                    paths: root.paths
                };

                if (isSymlinkInode(root)) (<SymlinkInode>shadow).symlink = root.symlink;
                shadows.set(shadow.ino, shadow);

                const iterator = core.getIterator(root.incomingLinks);
                try {
                    for (let i = core.nextResult(iterator); i; i = core.nextResult(iterator)) {
                        const [rootParent, rootNames] = i.value;
                        shadow.incomingLinks.set(rootParent && this._getShadow(rootParent), new core.SortedSet(this.stringComparer, rootNames));
                    }
                }
                finally {
                    core.closeIterator(iterator);
                }
            }

            return shadow;
        }

        private _copyShadowLinks(source: ReadonlyMap<string, Inode>, target: core.SortedMap<string, Inode>) {
            const iterator = core.getIterator(source);
            try {
                for (let i = core.nextResult(iterator); i; i = core.nextResult(iterator)) {
                    const [name, root] = i.value;
                    target.set(name, this._getShadow(root));
                }
            }
            finally {
                core.closeIterator(iterator);
            }
        }

        private _invalidatePaths(node: Inode) {
            node.paths = undefined;
            if (isDirectoryInode(node)) {
                const iterator = core.getIterator(this._getLinks(node).values());
                try {
                    for (let i = core.nextResult(iterator); i; i = core.nextResult(iterator)) {
                        const child = i.value;
                        this._invalidatePaths(child);
                    }
                }
                finally {
                    core.closeIterator(iterator);
                }
            }
        }

        private _getSize(node: FileInode): number {
            if (node.buffer) return node.buffer.byteLength;
            if (node.size !== undefined) return node.size;
            if (node.source && node.resolver) return node.size = node.resolver.statSync(node.source).size;
            if (this._shadowRoot && node.shadowRoot) return node.size = this._shadowRoot._getSize(node.shadowRoot);
            return 0;
        }

        private _getBuffer(node: FileInode): Buffer {
            if (!node.buffer) {
                const { source, resolver } = node;
                if (source && resolver) {
                    node.source = undefined;
                    node.resolver = undefined;
                    node.size = undefined;
                    node.buffer = resolver.readFileSync(source);
                }
                else if (this._shadowRoot && node.shadowRoot) {
                    node.buffer = this._shadowRoot._getBuffer(node.shadowRoot);
                }
                else {
                    node.buffer = Buffer.allocUnsafe(0);
                }
            }
            return node.buffer;
        }

        private _file(syscall: string, fd: number): OpenFileDescription;
        private _file(syscall: string, fd: number, kind: "directory"): OpenFileDescription<DirectoryInode>;
        private _file(syscall: string, fd: number, kind: "file", mode?: number): OpenFileDescription<FileInode>;
        private _file(syscall: string, fd: number, kind?: "file" | "directory", mode: number = F_OK) {
            const entry = this._openFiles.get(fd);
            if (!entry) throw new IOError("EBADF", syscall);
            if (kind === "file" && isDirectoryInode(entry.node)) throw new IOError("EISDIR", syscall);
            if (kind === "file" && !isFileInode(entry.node)) throw new IOError("EBADF", syscall);
            if (kind === "directory" && !isDirectoryInode(entry.node)) throw new IOError("EBADF", syscall);
            if (mode & W_OK && !isWritable(entry)) throw new IOError("EBADF", syscall);
            if (mode & R_OK && !isReadable(entry)) throw new IOError("EBADF", syscall);
            return entry;
        }

        private _find(path: string): FileDescription | undefined {
            return this._walk(path, /*noFollow*/ false);
        }

        private _lfind(path: string): FileDescription | undefined {
            return this._walk(path, /*noFollow*/ true);
        }

        // http://man7.org/linux/man-pages/man7/path_resolution.7.html
        private _walk(path: string, noFollow: boolean): FileDescription | undefined {
            let links: core.SortedMap<string, Inode> = this._getRootLinks();
            let parent: DirectoryInode | undefined;
            let components = vpath.parse(path);
            let step = 0;
            let depth = 0;
            while (step < components.length) {
                if (depth >= 40) throw new IOError("ELOOP", "scandir", vpath.format(components.slice(0, step)));

                const lastStep = step === components.length - 1;
                const basename = components[step];
                const node = links.get(basename);
                if (node === undefined) return undefined;

                if (isSymlinkInode(node) && !(noFollow && lastStep)) {
                    const dirname = vpath.format(components.slice(0, step));
                    const symlink = vpath.resolve(dirname, node.symlink);
                    if (!vpath.isAbsolute(symlink)) throw new Error("Path not absolute");

                    links = this._getRootLinks();
                    parent = undefined;
                    components = vpath.parse(symlink).concat(components.slice(step + 1));
                    step = 0;
                    depth++;
                    continue;
                }

                if (lastStep) {
                    const path = vpath.format(components);
                    if (!parent && isDirectoryInode(node)) parent = node;
                    if (!parent) throw new IOError("ENOENT", "scandir", path);
                    return { path, basename, parent, node };
                }

                if (isDirectoryInode(node)) {
                    links = this._getLinks(node);
                    parent = node;
                    step++;
                    continue;
                }

                throw new IOError("ENOTDIR", "scandir", vpath.format(components.slice(0, step + 1)));
            }

            return undefined;
        }

        private _resolve(path: string) {
            return this._cwd
                ? vpath.resolve(this._cwd, vpath.validate(path, vpath.ValidationFlags.RelativeOrAbsolute))
                : vpath.validate(path, vpath.ValidationFlags.Absolute);
        }

        private _applyFiles(files: FileSet, dirname: string) {
            const deferred: [Symlink | Link | Mount, string][] = [];
            this._applyFilesWorker(files, dirname, deferred);
            for (const [entry, path] of deferred) {
                this.mkdirpSync(vpath.dirname(path), 0o777);
                this.pushd(vpath.dirname(path));
                if (entry instanceof Symlink) {
                    if (this.stringComparer(vpath.dirname(path), path) === 0) {
                        throw new TypeError("Roots cannot be symbolic links.");
                    }
                    this.symlinkSync(entry.symlink, path);
                    this._applyFileExtendedOptions(path, entry);
                }
                else if (entry instanceof Link) {
                    if (this.stringComparer(vpath.dirname(path), path) === 0) {
                        throw new TypeError("Roots cannot be hard links.");
                    }
                    this.linkSync(entry.path, path);
                }
                else {
                    this.mountSync(entry.source, path, entry.resolver);
                    this._applyFileExtendedOptions(path, entry);
                }
                this.popd();
            }
        }

        private _applyFileExtendedOptions(path: string, entry: Directory | File | Symlink | Mount) {
            const { mode, meta } = entry;
            if (mode !== undefined) this.chmodSync(path, mode);
            if (meta !== undefined) {
                const filemeta = this.filemeta(path);
                for (const key of Object.keys(meta)) {
                    filemeta.set(key, meta[key]);
                }
            }
        }

        private _applyFilesWorker(files: FileSet, dirname: string, deferred: [Symlink | Link | Mount, string][]) {
            for (const key of Object.keys(files)) {
                const value = this._normalizeFileSetEntry(files[key]);
                const path = dirname ? vpath.resolve(dirname, key) : key;
                vpath.validate(path, vpath.ValidationFlags.Absolute);
                if (value === null || value === undefined) {
                    if (this.stringComparer(vpath.dirname(path), path) === 0) {
                        throw new TypeError("Roots cannot be deleted.");
                    }
                    this.rimrafSync(path);
                }
                else if (value instanceof File) {
                    if (this.stringComparer(vpath.dirname(path), path) === 0) {
                        throw new TypeError("Roots cannot be files.");
                    }
                    this.mkdirpSync(vpath.dirname(path), 0o777);
                    this.writeFileSync(path, value.data, value.encoding);
                    this._applyFileExtendedOptions(path, value);
                }
                else if (value instanceof Directory) {
                    this.mkdirpSync(path, 0o777);
                    this._applyFileExtendedOptions(path, value);
                    this._applyFilesWorker(value.files, path, deferred);
                }
                else {
                    deferred.push([value as Symlink | Link | Mount, path]);
                }
            }
        }

        private _normalizeFileSetEntry(value: FileSet[string]) {
            if (value === undefined ||
                value === null ||
                value instanceof Directory ||
                value instanceof File ||
                value instanceof Link ||
                value instanceof Symlink ||
                value instanceof Mount) {
                return value;
            }
            return typeof value === "string" || Buffer.isBuffer(value) ? new File(value) : new Directory(value);
        }
    }

    export interface FileSystemOptions {
        time?: number | Date | (() => number | Date);
        files?: FileSet;
        cwd?: string;
        meta?: Record<string, any>;
    }

    export type Axis = "ancestors" | "ancestors-or-self" | "self" | "descendants-or-self" | "descendants";

    export interface Traversal {
        traverse?(path: string, stats: Stats): boolean;
        accept?(path: string, stats: Stats): boolean;
    }

    export interface FileSystemResolver {
        statSync(path: string): { mode: number; size: number; };
        readdirSync(path: string): string[];
        readFileSync(path: string): Buffer;
    }

    export class Stats {
        public dev: number;
        public ino: number;
        public mode: number;
        public nlink: number;
        public uid: number;
        public gid: number;
        public rdev: number;
        public size: number;
        public blksize: number;
        public blocks: number;
        public atimeMs: number;
        public mtimeMs: number;
        public ctimeMs: number;
        public birthtimeMs: number;
        public atime: Date;
        public mtime: Date;
        public ctime: Date;
        public birthtime: Date;

        constructor();
        constructor(dev: number, ino: number, mode: number, nlink: number, rdev: number, size: number, blksize: number, blocks: number, atimeMs: number, mtimeMs: number, ctimeMs: number, birthtimeMs: number);
        constructor(dev = 0, ino = 0, mode = 0, nlink = 0, rdev = 0, size = 0, blksize = 0, blocks = 0, atimeMs = 0, mtimeMs = 0, ctimeMs = 0, birthtimeMs = 0) {
            this.dev = dev;
            this.ino = ino;
            this.mode = mode;
            this.nlink = nlink;
            this.uid = 0;
            this.gid = 0;
            this.rdev = rdev;
            this.size = size;
            this.blksize = blksize;
            this.blocks = blocks;
            this.atimeMs = atimeMs;
            this.mtimeMs = mtimeMs;
            this.ctimeMs = ctimeMs;
            this.birthtimeMs = birthtimeMs;
            this.atime = new Date(this.atimeMs);
            this.mtime = new Date(this.mtimeMs);
            this.ctime = new Date(this.ctimeMs);
            this.birthtime = new Date(this.birthtimeMs);
        }

        public isFile() { return (this.mode & S_IFMT) === S_IFREG; }
        public isDirectory() { return (this.mode & S_IFMT) === S_IFDIR; }
        public isSymbolicLink() { return (this.mode & S_IFMT) === S_IFLNK; }
        public isBlockDevice() { return (this.mode & S_IFMT) === S_IFBLK; }
        public isCharacterDevice() { return (this.mode & S_IFMT) === S_IFCHR; }
        public isFIFO() { return (this.mode & S_IFMT) === S_IFIFO; }
        public isSocket() { return (this.mode & S_IFMT) === S_IFSOCK; }
    }

    // tslint:disable-next-line:variable-name
    export const IOErrorMessages = Object.freeze({
        EACCES: "access denied",
        EIO: "an I/O error occurred",
        ENOENT: "no such file or directory",
        EEXIST: "file already exists",
        ELOOP: "too many symbolic links encountered",
        ENOTDIR: "no such directory",
        EISDIR: "path is a directory",
        EBADF: "invalid file descriptor",
        EINVAL: "invalid value",
        ENOTEMPTY: "directory not empty",
        EPERM: "operation not permitted",
        EROFS: "file system is read-only"
    });

    export class IOError extends Error {
        public readonly code: string;
        public readonly syscall: string | undefined;
        public readonly path: string | undefined;
        public readonly dest: string | undefined;

        constructor(code: keyof typeof IOErrorMessages, syscall?: string, path?: string, dest?: string) {
            let message = `${code}: ${IOErrorMessages[code]}`;
            if (syscall !== undefined) {
                message += `, ${syscall}`;
                if (path !== undefined) {
                    message += ` '${path}'`;
                    if (dest !== undefined) {
                        message += ` -> '${dest}'`;
                    }
                }
            }
            super(message);
            this.name = "Error";
            this.code = code;
            this.syscall = syscall;
            this.path = path;
            this.dest = dest;
        }
    }

    /**
     * A template used to populate files, directories, links, etc. in a virtual file system.
     */
    export interface FileSet {
        [name: string]: DirectoryLike | FileLike | Link | Symlink | Mount | null | undefined;
    }

    export type DirectoryLike = FileSet | Directory;
    export type FileLike = File | Buffer | string;

    /** Extended options for a directory in a `FileSet` */
    export class Directory {
        public readonly files: FileSet;
        public readonly mode: number | undefined;
        public readonly meta: Record<string, any> | undefined;
        constructor(files: FileSet, { mode, meta }: { mode?: number, meta?: Record<string, any> } = {}) {
            this.files = files;
            this.mode = mode;
            this.meta = meta;
        }
    }

    /** Extended options for a file in a `FileSet` */
    export class File {
        public readonly data: Buffer | string;
        public readonly encoding: string | undefined;
        public readonly mode: number | undefined | undefined;
        public readonly meta: Record<string, any> | undefined;
        constructor(data: Buffer | string, { mode, meta, encoding }: { encoding?: string, mode?: number, meta?: Record<string, any> } = {}) {
            this.data = data;
            this.encoding = encoding;
            this.mode = mode;
            this.meta = meta;
        }
    }

    /** Extended options for a hard link in a `FileSet` */
    export class Link {
        public readonly path: string;
        constructor(path: string) {
            this.path = path;
        }
    }

    /** Extended options for a symbolic link in a `FileSet` */
    export class Symlink {
        public readonly symlink: string;
        public readonly mode: number | undefined;
        public readonly meta: Record<string, any> | undefined;
        constructor(symlink: string, { mode, meta }: { mode?: number, meta?: Record<string, any> } = {}) {
            this.symlink = symlink;
            this.mode = mode;
            this.meta = meta;
        }
    }

    /** Extended options for mounting a virtual copy of an external file system via a `FileSet` */
    export class Mount {
        public readonly source: string;
        public readonly resolver: FileSystemResolver;
        public readonly mode: number | undefined;
        public readonly meta: Record<string, any> | undefined;
        constructor(source: string, resolver: FileSystemResolver, { mode, meta }: { mode?: number, meta?: Record<string, any> } = {}) {
            this.source = source;
            this.resolver = resolver;
            this.mode = mode;
            this.meta = meta;
        }
    }

    // a generic POSIX inode
    type Inode = FileInode | DirectoryInode | SymlinkInode;

    interface InodeBase {
        // inode
        dev: number; // device id
        ino: number; // inode id
        mode: number; // file mode
        atimeMs: number; // access time
        mtimeMs: number; // modified time
        ctimeMs: number; // status change time
        birthtimeMs: number; // creation time
        nlink: number; // number of hard links

        // extra
        shadowRoot: Inode | undefined;
        incomingLinks: Map<DirectoryInode | undefined, core.SortedSet<string>>;
        paths?: ReadonlyArray<string>;
        meta?: core.Metadata; // metadata stored on the inode
    }

    interface FileInode extends InodeBase {
        // file inode
        size: number | undefined;
        buffer: Buffer;
        source: string | undefined;
        resolver: FileSystemResolver | undefined;
        shadowRoot: FileInode | undefined;
    }

    interface DirectoryInode extends InodeBase {
        // directory inode
        links: core.SortedMap<string, Inode> | undefined;
        source: string | undefined;
        resolver: FileSystemResolver | undefined;
        shadowRoot: DirectoryInode | undefined;
    }

    interface SymlinkInode extends InodeBase {
        // symlink inode
        symlink: string;
        shadowRoot: SymlinkInode | undefined;
    }

    function isFileInode(node: Inode): node is FileInode {
        return (node.mode & S_IFMT) === S_IFREG;
    }

    function isDirectoryInode(node: Inode): node is DirectoryInode {
        return (node.mode & S_IFMT) === S_IFDIR;
    }

    function isSymlinkInode(node: Inode): node is SymlinkInode {
        return (node.mode & S_IFMT) === S_IFLNK;
    }

    interface FileDescription<TInode extends Inode = Inode> {
        path: string;
        basename: string;
        parent: DirectoryInode;
        node: TInode;
    }

    interface OpenFileDescription<TInode extends Inode = Inode> extends FileDescription<TInode> {
        fd: number;
        flags: number;
        offset: number;
        written: boolean;
        buffer: Buffer | undefined;
    }

    function isReadable(file: OpenFileDescription) {
        return (file.flags & O_ACCMODE) !== O_WRONLY;
    }

    function isWritable(file: OpenFileDescription) {
        return (file.flags & O_ACCMODE) !== O_RDONLY;
    }

    function parseFlags(flags: string | number) {
        if (typeof flags === "string") {
            switch (flags) {
                case "r": return O_RDONLY;
                case "r+": return O_RDWR;
                case "rs+": return O_RDWR;
                case "w": return O_WRONLY | O_TRUNC | O_CREAT;
                case "wx": return O_WRONLY | O_TRUNC | O_CREAT | O_EXCL;
                case "w+": return O_RDWR | O_TRUNC | O_CREAT;
                case "wx+": return O_RDWR | O_TRUNC | O_CREAT | O_EXCL;
                case "a": return O_WRONLY | O_APPEND | O_CREAT;
                case "ax": return O_WRONLY | O_APPEND | O_CREAT | O_EXCL;
                case "a+": return O_RDWR | O_APPEND | O_CREAT;
                case "ax+": return O_RDWR | O_APPEND | O_CREAT | O_EXCL;
                default: throw new Error(`Unrecognized file open flag: ${flags}`);
            }
        }
        return flags;
    }

    function resizeBuffer(buffer: Buffer, size: number) {
        if (buffer.byteLength === size) return buffer;
        const newBuffer = Buffer.allocUnsafe(size);
        newBuffer.fill(0, buffer.copy(newBuffer));
        return newBuffer;
    }
}
// tslint:enable:no-null-keyword

import sys
import re

def parse_pd(filename):
    with open(filename, 'r') as f:
        lines = f.readlines()

    objects = []
    connections = []
    
    # PD IDs are 0-based index of the object lines (lines starting with #X)
    # The first line #N canvas is NOT an object in this referencing reference usually?
    # Actually, often the canvas is not addressable by connect, but subpatches are.
    # In standard PD files, #X objects are the nodes.
    
    obj_pattern = re.compile(r'^#X (obj|msg|float|text|symbol|restore) (.*);')
    # Note: 'restore' ends a subpatch? No, we assume flat file for now or handle simple nesting.
    # But this file seems flat-ish.
    
    connect_pattern = re.compile(r'^#X connect (\d+) (\d+) (\d+) (\d+);')
    
    obj_count = 0
    
    for i, line in enumerate(lines):
        line = line.strip()
        if line.startswith('#X connect'):
            m = connect_pattern.match(line)
            if m:
                connections.append({
                    'line': i + 1,
                    'src': int(m.group(1)),
                    'src_out': int(m.group(2)),
                    'dst': int(m.group(3)),
                    'dst_in': int(m.group(4)),
                    'text': line
                })
        elif line.startswith('#X'):
            # It's an object/node
            # We store the original text to identify it
            content = line[3:].strip() # remove #X
            objects.append({
                'id': obj_count,
                'line': i + 1,
                'content': content
            })
            obj_count += 1

    print(f"Found {len(objects)} objects and {len(connections)} connections.")
    
    print("\n--- Objects ---")
    for o in objects:
        print(f"ID {o['id']}: {o['content']} (Line {o['line']})")

    print("\n--- Connections ---")
    for c in connections:
        print(f"Line {c['line']}: {c['src']} (out {c['src_out']}) -> {c['dst']} (in {c['dst_in']})")

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python analyze_pd.py <file.pd>")
        sys.exit(1)
    parse_pd(sys.argv[1])

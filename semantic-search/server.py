#!/usr/bin/env python3
"""
Semantic Search Server
Uses ChromaDB + Ollama embeddings
Port: 3037
"""

import os
import json
import requests
from flask import Flask, request, jsonify
import chromadb
from chromadb.config import Settings

from middleware.verify_signed import flask_middleware

app = Flask(__name__)
flask_middleware(app)  # gated by AUTH_MODE (off | observe | enforce)

# Config
OLLAMA_URL = os.getenv('OLLAMA_URL', 'http://localhost:11434')
EMBEDDING_MODEL = os.getenv('EMBEDDING_MODEL', 'nomic-embed-text')
CHROMA_PATH = os.getenv('CHROMA_PATH', './data')
PORT = int(os.getenv('PORT', 3037))

# Initialize ChromaDB
client = chromadb.PersistentClient(path=CHROMA_PATH)

# Collections
conversations_collection = client.get_or_create_collection(
    name='conversations',
    metadata={'description': 'Agent conversations'}
)

training_collection = client.get_or_create_collection(
    name='training_data',
    metadata={'description': 'Training data with reasoning'}
)

project_memory_collection = client.get_or_create_collection(
    name='project_memory',
    metadata={'description': 'Files from project-memory'}
)

session_summaries_collection = client.get_or_create_collection(
    name='session_summaries',
    metadata={'description': 'Session summaries for inject-context'}
)

notes_collection = client.get_or_create_collection(
    name='notes',
    metadata={'description': 'Agent notes — handoffs, decisions, observations'}
)


def get_embedding(text: str):
    """Get embedding from Ollama.

    Returns (embedding, None) on success or (None, error_dict) on failure.
    error_dict has 'reason' and 'fix' fields so callers can surface a
    precise 503 to the client rather than a generic 500.
    """
    try:
        response = requests.post(
            f'{OLLAMA_URL}/api/embeddings',
            json={
                'model': EMBEDDING_MODEL,
                'prompt': text[:8000],  # Limit text length
            },
            timeout=30,
        )
    except requests.exceptions.ConnectionError:
        return None, {
            'reason': 'ollama_unreachable',
            'detail': f'cannot reach {OLLAMA_URL}',
            'fix': 'Install Ollama on the host and start it. '
                   'Linux:  curl -fsSL https://ollama.com/install.sh | sh && ollama serve. '
                   'Mac/Windows: install and open Ollama.app.',
        }
    except requests.exceptions.Timeout:
        return None, {
            'reason': 'ollama_timeout',
            'detail': 'ollama took longer than 30s to respond',
            'fix': 'First call on a cold model can take up to ~60s. '
                   'Retry once. If timeouts persist, check host CPU/RAM.',
        }
    except Exception as e:
        return None, {'reason': 'ollama_request_error', 'detail': str(e)}

    if response.status_code == 404:
        return None, {
            'reason': 'model_not_loaded',
            'detail': f'{EMBEDDING_MODEL} is not pulled on this ollama',
            'fix': f'ollama pull {EMBEDDING_MODEL}',
        }
    try:
        response.raise_for_status()
        return response.json()['embedding'], None
    except Exception as e:
        return None, {
            'reason': 'ollama_bad_response',
            'detail': f'{response.status_code}: {str(e)}',
        }


@app.route('/health', methods=['GET'])
def health():
    return jsonify({
        'status': 'ok',
        'collections': {
            'conversations': conversations_collection.count(),
            'training_data': training_collection.count(),
            'project_memory': project_memory_collection.count(),
            'session_summaries': session_summaries_collection.count(),
            'notes': notes_collection.count()
        },
        'embedding_model': EMBEDDING_MODEL
    })


@app.route('/api/embed', methods=['POST'])
def embed_document():
    """Add document to collection"""
    data = request.json
    collection_name = data.get('collection', 'conversations')
    doc_id = data.get('id')
    text = data.get('text')
    # ChromaDB upsert rejects empty metadata dict — fall back to {'source': 'api'}
    metadata = data.get('metadata') or {'source': 'api'}

    if not doc_id or not text:
        return jsonify({'error': 'Missing id or text'}), 400

    # Get collection
    if collection_name == 'conversations':
        collection = conversations_collection
    elif collection_name == 'training_data':
        collection = training_collection
    elif collection_name == 'project_memory':
        collection = project_memory_collection
    elif collection_name == 'session_summaries':
        collection = session_summaries_collection
    elif collection_name == 'notes':
        collection = notes_collection
    else:
        return jsonify({'error': 'Unknown collection'}), 400

    # Get embedding
    embedding, err = get_embedding(text)
    if err:
        return jsonify({'error': 'embedding_failed', **err}), 503

    # Add to collection
    collection.upsert(
        ids=[doc_id],
        embeddings=[embedding],
        documents=[text],
        metadatas=[metadata]
    )

    return jsonify({
        'id': doc_id,
        'collection': collection_name,
        'embedded': True
    })


@app.route('/api/search', methods=['GET', 'POST'])
def search():
    """Semantic search across collections"""
    if request.method == 'POST':
        data = request.json
        query = data.get('query')
        collection_name = data.get('collection')
        limit = data.get('limit', 5)
    else:
        query = request.args.get('q')
        collection_name = request.args.get('collection')
        limit = int(request.args.get('limit', 5))

    if not query:
        return jsonify({'error': 'Missing query'}), 400

    # Get embedding for query
    query_embedding, err = get_embedding(query)
    if err:
        return jsonify({'error': 'embedding_failed', **err}), 503

    results = []

    # Search in specified collection or all
    collections_to_search = []
    if collection_name:
        if collection_name == 'conversations':
            collections_to_search = [('conversations', conversations_collection)]
        elif collection_name == 'training_data':
            collections_to_search = [('training_data', training_collection)]
        elif collection_name == 'project_memory':
            collections_to_search = [('project_memory', project_memory_collection)]
        elif collection_name == 'session_summaries':
            collections_to_search = [('session_summaries', session_summaries_collection)]
        elif collection_name == 'notes':
            collections_to_search = [('notes', notes_collection)]
    else:
        # Search all collections
        collections_to_search = [
            ('conversations', conversations_collection),
            ('training_data', training_collection),
            ('project_memory', project_memory_collection),
            ('session_summaries', session_summaries_collection),
            ('notes', notes_collection)
        ]

    for coll_name, collection in collections_to_search:
        if collection.count() == 0:
            continue

        search_results = collection.query(
            query_embeddings=[query_embedding],
            n_results=min(limit, collection.count())
        )

        for i, doc_id in enumerate(search_results['ids'][0]):
            results.append({
                'id': doc_id,
                'collection': coll_name,
                'text': search_results['documents'][0][i][:500],
                'metadata': search_results['metadatas'][0][i] if search_results['metadatas'] else {},
                'distance': search_results['distances'][0][i] if search_results['distances'] else None
            })

    # Sort by distance (lower = better)
    results.sort(key=lambda x: x.get('distance', 999))
    results = results[:limit]

    return jsonify({
        'query': query,
        'total': len(results),
        'results': results
    })


@app.route('/api/index-project-memory', methods=['POST'])
def index_project_memory():
    """Index all files from a project-memory directory supplied by the caller."""
    data = request.json or {}
    path = data.get('path')
    if not path:
        return jsonify({'error': 'Missing "path" in request body'}), 400

    indexed = 0
    errors = []

    import glob
    for filepath in glob.glob(f'{path}/**/*.md', recursive=True):
        try:
            with open(filepath, 'r', encoding='utf-8') as f:
                content = f.read()

            doc_id = filepath.replace(path, '').strip('/')

            embedding, err = get_embedding(content)
            if embedding:
                project_memory_collection.upsert(
                    ids=[doc_id],
                    embeddings=[embedding],
                    documents=[content],
                    metadatas=[{'path': filepath, 'type': 'markdown'}]
                )
                indexed += 1
            else:
                errors.append(f'{filepath}: {err.get("reason", "embedding_failed")}')

        except Exception as e:
            errors.append(f'{filepath}: {str(e)}')

    return jsonify({
        'indexed': indexed,
        'errors': errors[:10]  # Limit errors in response
    })


if __name__ == '__main__':
    print(f'Semantic Search Server starting on port {PORT}')
    print(f'ChromaDB path: {CHROMA_PATH}')
    print(f'Embedding model: {EMBEDDING_MODEL}')
    print(f'Collections: conversations, training_data, project_memory, session_summaries, notes')
    app.run(host='0.0.0.0', port=PORT)

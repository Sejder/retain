# Algorithms

## Complexity #flashcards/cs/algorithms
Time complexity of binary search?::$O(\log n)$
Time complexity of merge sort?::$O(n \log n)$ in all cases.
What data structure does Dijkstra's algorithm use?::A priority queue (min-heap).
What does `git rebase` do?::Replays your commits on top of another base commit.
Difference between a stack and a queue?::Stack: last in, first out. Queue: first in, first out.
What is dynamic programming?::Solving a problem by combining solutions to overlapping subproblems, storing each result once.

## Sorting #flashcards/cs/algorithms
What are the steps of merge sort?
::
1. Split the list in half
2. Sort each half recursively
3. Merge the two sorted halves

What does this print?
```python
xs = [3, 1, 2]

print(sorted(xs, reverse=True))
```
::
`[3, 2, 1]`

Recurrence for merge sort?
::
$$
T(n) = 2T\left(\frac{n}{2}\right) + O(n)
$$
which solves to $O(n \log n)$.

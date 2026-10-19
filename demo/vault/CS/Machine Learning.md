# Machine learning

## Flashcards #flashcards/cs/ml
Entropy of a set with class fractions $p_i$?::$H(S) = -\sum_i p_i \log_2 p_i$
What is overfitting?::Fitting noise in the training data, so the model generalizes poorly to new data.
Gradient descent update rule?::$w \leftarrow w - \eta \nabla_w L(w)$
What does the bias–variance tradeoff describe?::Simple models underfit (high bias); complex models overfit (high variance).
What does $k$ control in $k$-nearest neighbours?::Smoothness: small $k$ gives a jagged boundary, large $k$ a smoother one.
Sigmoid function?::$\sigma(z) = \dfrac{1}{1 + e^{-z}}$
What is the purpose of a validation set?::Choosing hyperparameters without touching the test set.

## Training loop #flashcards/cs/ml
The four steps of one training step?
::
1. Forward pass: compute predictions
2. Compute the loss
3. Backward pass: compute gradients
4. Update the weights

Precision vs. recall?
::
- **Precision:** of everything predicted positive, how much is positive. $\frac{TP}{TP + FP}$
- **Recall:** of everything positive, how much was found. $\frac{TP}{TP + FN}$
